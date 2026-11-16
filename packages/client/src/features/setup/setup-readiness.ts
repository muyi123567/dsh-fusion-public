import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import type { FusionProviderStatusMap } from "../bridges/bridge-sources-model.js";

export type SetupCheckId = "runtime" | "nodes" | "config" | "collaboration";
export type SetupTone = "ready" | "attention" | "pending" | "optional";
export type SetupTarget = "config" | "fleet" | "tasks" | null;

export interface SetupCheck {
  id: SetupCheckId;
  label: string;
  detail: string;
  tone: SetupTone;
  required: boolean;
}

export interface SetupNextAction {
  label: string;
  detail: string;
  tone: SetupTone;
  target: SetupTarget;
}

export interface SetupReadiness {
  checks: SetupCheck[];
  nextAction: SetupNextAction;
  readyRequired: number;
  totalRequired: number;
}

export interface SetupReadinessInput {
  snapshotLoaded: boolean;
  pluginMode: boolean;
  nodes: readonly NodeRecord[];
  providers: FusionProviderStatusMap;
  config: ConfigSnapshot;
}

const collaborationProviderIds = ["agentTeams", "agentBus", "room"] as const;

function runtimeCheck(input: SetupReadinessInput): SetupCheck {
  if (!input.pluginMode) {
    return {
      id: "runtime",
      label: "DSH 插件运行时",
      detail: "当前是独立预览，不经过 DSH 插件路由",
      tone: "optional",
      required: false,
    };
  }
  if (!input.snapshotLoaded) {
    return {
      id: "runtime",
      label: "DSH 插件运行时",
      detail: "等待宿主返回首个权威快照",
      tone: "pending",
      required: true,
    };
  }
  if (input.config.revision === "unobserved") {
    return {
      id: "runtime",
      label: "DSH 插件运行时",
      detail: "宿主快照未报告 Fusion 配置版本",
      tone: "attention",
      required: true,
    };
  }
  const version = input.config.pluginVersions["dsh-fusion"]?.trim();
  return {
    id: "runtime",
    label: "DSH 插件运行时",
    detail: version === undefined || version === ""
      ? "宿主已响应，但未报告插件版本"
      : `Fusion ${version} 已由宿主加载`,
    tone: version === undefined || version === "" ? "attention" : "ready",
    required: true,
  };
}

function nodesCheck(input: SetupReadinessInput): SetupCheck {
  if (!input.snapshotLoaded) {
    return {
      id: "nodes",
      label: "执行节点",
      detail: "等待节点快照",
      tone: "pending",
      required: true,
    };
  }
  if (input.nodes.length === 0) {
    return {
      id: "nodes",
      label: "执行节点",
      detail: "尚未配置 SSH 或 Instabox 节点",
      tone: "attention",
      required: true,
    };
  }
  const online = input.nodes.filter((node) => node.status === "online").length;
  if (online === 0) {
    return {
      id: "nodes",
      label: "执行节点",
      detail: `${input.nodes.length} 个节点已配置，当前均不可执行`,
      tone: "attention",
      required: true,
    };
  }
  return {
    id: "nodes",
    label: "执行节点",
    detail: `${online}/${input.nodes.length} 个节点在线`,
    tone: "ready",
    required: true,
  };
}

function configCheck(input: SetupReadinessInput): SetupCheck {
  if (!input.snapshotLoaded || input.config.revision === "unobserved") {
    return {
      id: "config",
      label: "配置一致性",
      detail: "等待宿主报告配置版本",
      tone: "pending",
      required: true,
    };
  }
  if (input.nodes.length === 0) {
    return {
      id: "config",
      label: "配置一致性",
      detail: "接入节点后再验证配置",
      tone: "pending",
      required: true,
    };
  }
  const driftIds = new Set(
    Object.entries(input.config.nodeStates)
      .filter(([, state]) => state === "drift")
      .map(([nodeId]) => nodeId),
  );
  for (const node of input.nodes) {
    if (node.configState === "drift") driftIds.add(node.id);
  }
  if (driftIds.size > 0) {
    return {
      id: "config",
      label: "配置一致性",
      detail: `${driftIds.size} 个节点与期望配置不一致`,
      tone: "attention",
      required: true,
    };
  }
  const current = input.nodes.filter((node) =>
    node.configState === "current" || input.config.nodeStates[node.id] === "current"
  ).length;
  if (current === 0) {
    return {
      id: "config",
      label: "配置一致性",
      detail: "节点配置尚未完成读取与校验",
      tone: "attention",
      required: true,
    };
  }
  if (current < input.nodes.length) {
    return {
      id: "config",
      label: "配置一致性",
      detail: `${current}/${input.nodes.length} 个节点配置已验证，仍有 ${input.nodes.length - current} 个节点未验证`,
      tone: "attention",
      required: true,
    };
  }
  return {
    id: "config",
    label: "配置一致性",
    detail: `${current}/${input.nodes.length} 个节点配置已验证`,
    tone: "ready",
    required: true,
  };
}

function collaborationCheck(input: SetupReadinessInput): SetupCheck {
  const observed = collaborationProviderIds
    .map((providerId) => input.providers[providerId])
    .filter((status) => status !== undefined);
  const connected = observed.filter((status) =>
    status.state === "connected" || status.state === "degraded"
  );
  const degraded = observed.filter((status) => status.state === "degraded");

  if (observed.length === 0) {
    return {
      id: "collaboration",
      label: "协作组件",
      detail: "Room、AgentTeams、AgentBus 未安装或未配置",
      tone: "optional",
      required: false,
    };
  }
  if (connected.length === 0) {
    return {
      id: "collaboration",
      label: "协作组件",
      detail: "已报告状态，但当前没有可用协作连接",
      tone: "attention",
      required: false,
    };
  }
  return {
    id: "collaboration",
    label: "协作组件",
    detail: degraded.length === 0
      ? `${connected.length} 个协作组件已连接`
      : `${connected.length} 个已连接，${degraded.length} 个降级`,
    tone: degraded.length === 0 ? "ready" : "attention",
    required: false,
  };
}

function selectNextAction(
  checks: readonly SetupCheck[],
  nodes: readonly NodeRecord[],
): SetupNextAction {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const runtime = byId.get("runtime");
  const nodeCheck = byId.get("nodes");
  const config = byId.get("config");

  if (runtime?.tone === "pending") {
    return {
      label: "等待宿主快照",
      detail: "收到权威状态后会自动更新检查结果。",
      tone: "pending",
      target: null,
    };
  }
  if (runtime?.tone === "attention") {
    return {
      label: "检查插件运行状态",
      detail: "宿主未报告 Fusion 版本，先确认插件已加载并重启 profile。",
      tone: "attention",
      target: null,
    };
  }
  if (nodeCheck?.tone === "attention") {
    return nodes.length === 0
      ? {
          label: "添加执行节点",
          detail: "先接入一台 SSH 或 Instabox 节点，再运行连接检查。",
          tone: "attention",
          target: "config",
        }
      : {
          label: "检查节点连接",
          detail: "节点已配置但当前不可执行，检查网络、凭据引用和远端服务。",
          tone: "attention",
          target: "fleet",
        };
  }
  if (config?.tone === "attention") {
    return {
      label: config.detail.includes("不一致") ? "处理配置漂移" : "验证节点配置",
      detail: config.detail,
      tone: "attention",
      target: "config",
    };
  }
  if (config?.tone === "pending") {
    return {
      label: "完成节点配置",
      detail: "配置读取完成后才能确认运行时一致性。",
      tone: "pending",
      target: "config",
    };
  }
  return {
    label: "发起首项多机任务",
    detail: "基础链路已就绪，运行一项任务验证派发、证据与恢复。",
    tone: "ready",
    target: "tasks",
  };
}

export function buildSetupReadiness(input: SetupReadinessInput): SetupReadiness {
  const checks = [
    runtimeCheck(input),
    nodesCheck(input),
    configCheck(input),
    collaborationCheck(input),
  ];
  const required = checks.filter((check) => check.required);
  return {
    checks,
    nextAction: selectNextAction(checks, input.nodes),
    readyRequired: required.filter((check) => check.tone === "ready").length,
    totalRequired: required.length,
  };
}
