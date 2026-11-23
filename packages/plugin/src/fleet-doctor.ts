import type { FleetDriftReport } from "./fleet-environment.js";

export type FleetDoctorStatus = "ok" | "warn" | "fail";

export interface FleetDoctorCheck {
  id: string;
  status: FleetDoctorStatus;
  summary: string;
  remedy?: string;
}

export interface FleetDoctorIntegration {
  id: string;
  package: string;
  transport: "mcp" | "service" | "none";
  installed: boolean;
  enabled: boolean;
  version?: string;
}

export interface FleetDoctorReport {
  overall: FleetDoctorStatus;
  checkedAt: string;
  checks: FleetDoctorCheck[];
  integrations: FleetDoctorIntegration[];
  nextActions: string[];
}

export interface FleetDoctorBundle {
  name: string;
  version?: string;
  enabled: boolean;
  availability?: string;
}

export interface FleetDoctorInput {
  dsh: {
    version: string;
    state: "verified" | "untested" | "unsupported" | "unknown";
  };
  environment: {
    available: boolean;
    digest?: string;
    signed?: boolean;
    report?: FleetDriftReport;
    error?: string;
  };
  mcp: {
    enabled: boolean;
    listening: boolean;
    registered: boolean;
    port?: number;
    clients: number;
    error?: string;
  };
  execution: {
    jobs: number;
    nodes: number;
    ledgerConfigured: boolean;
    directoryConfigured: boolean;
  };
  bundles: FleetDoctorBundle[];
}

const INTEGRATIONS = [
  { id: "ds-bot", package: "ds-bot", transport: "mcp" as const },
  { id: "dsh-im", package: "@xmanrui/dsh-im", transport: "mcp" as const },
  { id: "dsh-qqbot", package: "@tencent-connect/dsh-qqbot", transport: "mcp" as const },
  { id: "modlens", package: "@liustack/modlens", transport: "none" as const },
] as const;

export function buildFleetDoctorReport(input: FleetDoctorInput, now = new Date()): FleetDoctorReport {
  const checks: FleetDoctorCheck[] = [];
  const bundles = new Map(input.bundles.map(bundle => [bundle.name, bundle]));

  checks.push(input.dsh.state === "verified"
    ? { id: "dsh.version", status: "ok", summary: `DSH ${input.dsh.version} 已验证` }
    : input.dsh.state === "unsupported"
      ? {
          id: "dsh.version", status: "fail", summary: `DSH ${input.dsh.version} 不在支持范围`,
          remedy: "升级或降级到 >=0.2.0-rc.2 <0.3.0 的受支持版本",
        }
      : {
          id: "dsh.version", status: "warn", summary: `DSH ${input.dsh.version} 未标记为已验证`,
          remedy: "先在隔离 profile 启动并验证，再用于生产",
        });

  if (!input.environment.available) {
    checks.push({
      id: "environment.manifest", status: "fail",
      summary: `环境清单不可用${input.environment.error === undefined ? "" : `：${input.environment.error}`}`,
      remedy: "检查 profileContext、pluginManager 与 fleetEnvironment.directory 权限",
    });
  } else if (input.environment.signed !== true) {
    checks.push({
      id: "environment.manifest", status: "warn", summary: "环境清单未签名",
      remedy: "检查主机密钥文件与签名依赖",
    });
  } else {
    checks.push({ id: "environment.manifest", status: "ok", summary: `环境清单已签名：${input.environment.digest ?? "摘要未知"}` });
  }

  const drift = input.environment.report;
  if (drift === undefined) {
    checks.push({
      id: "environment.drift", status: "warn", summary: "未配置期望环境，无法判断漂移",
      remedy: "配置 expectedManifestPath 或提供 expectedDigest",
    });
  } else if (drift.overall === "match") {
    checks.push({ id: "environment.drift", status: "ok", summary: "环境与期望一致" });
  } else if (drift.overall === "unknown") {
    const unconfigured = drift.reason?.includes("未配置期望") === true;
    checks.push({
      id: "environment.drift", status: "warn",
      summary: unconfigured ? "未配置期望环境，无法判断漂移" : `环境状态未知：${drift.reason ?? "来源不可用"}`,
      remedy: unconfigured ? "配置 expectedManifestPath 或提供 expectedDigest" : "刷新清单并确认主机在线、签名有效",
    });
  } else {
    const blocking = drift.items.filter(item => item.severity === "block");
    checks.push({
      id: "environment.drift", status: blocking.length > 0 ? "fail" : "warn",
      summary: blocking.length > 0 ? `${blocking.length} 项阻塞级环境漂移` : "存在非阻塞环境差异",
      remedy: "按漂移项的 remedy 对齐环境，或更新期望清单",
    });
  }

  checks.push(input.mcp.enabled
    ? input.mcp.listening
      ? { id: "mcp.endpoint", status: "ok", summary: `MCP 监听 127.0.0.1:${input.mcp.port ?? "?"}` }
      : {
          id: "mcp.endpoint", status: "fail",
          summary: `MCP 已启用但未监听${input.mcp.error === undefined ? "" : `：${input.mcp.error}`}`,
          remedy: "检查端口占用与 127.0.0.1 绑定权限",
        }
    : {
        id: "mcp.endpoint", status: "warn", summary: "MCP 未启用，DS-Bot 等 Agent 不会自动获得鲸群工具",
        remedy: "在 fleetMcp.enabled 中显式启用，并按客户端发放令牌",
      });

  checks.push(input.mcp.enabled && input.mcp.listening
    ? input.mcp.registered
      ? { id: "mcp.manager", status: "ok", summary: "已通过 mcpManager 注册 whale-fleet" }
      : {
          id: "mcp.manager", status: "warn", summary: "mcpManager 未注册，工具仅对持有外部令牌的客户端可用",
          remedy: "确认宿主挂载 mcp-manager，或让 Agent 使用外部 MCP 配置",
        }
    : { id: "mcp.manager", status: "ok", summary: "MCP 未启用，跳过注册检查" });

  checks.push(input.mcp.clients > 0
    ? { id: "mcp.clients", status: "ok", summary: `${input.mcp.clients} 个可撤销客户端` }
    : {
        id: "mcp.clients", status: "warn", summary: "没有外部 MCP 客户端令牌",
        remedy: "运行 fleet-mcp-token.mjs 为 Claude/Codex/脚本发放只读令牌",
      });

  checks.push(input.execution.jobs > 0
    ? { id: "execution.jobs", status: "ok", summary: `${input.execution.jobs} 个 allowlisted 作业` }
    : {
        id: "execution.jobs", status: "warn", summary: "没有 allowlisted 执行作业",
        remedy: "在 nativeTaskExecution.jobs 中配置固定命令与节点",
      });
  checks.push(input.execution.nodes > 0
    ? { id: "execution.nodes", status: "ok", summary: `${input.execution.nodes} 个执行节点` }
    : {
        id: "execution.nodes", status: "warn", summary: "没有执行节点",
        remedy: "配置 sshNodes 或 instaboxNodes",
      });
  checks.push(input.execution.ledgerConfigured && input.execution.directoryConfigured
    ? { id: "execution.store", status: "ok", summary: "执行账本与目录已配置" }
    : {
        id: "execution.store", status: "warn", summary: "执行账本或目录未配置",
        remedy: "设置 taskLedgerPath 与 nativeTaskExecution.directory",
      });

  const integrations: FleetDoctorIntegration[] = INTEGRATIONS.map(integration => {
    const bundle = bundles.get(integration.package);
    return {
      id: integration.id,
      package: integration.package,
      transport: integration.transport,
      installed: bundle !== undefined,
      enabled: bundle?.enabled === true,
      ...(bundle?.version === undefined ? {} : { version: bundle.version }),
    };
  });
  for (const integration of integrations) {
    if (!integration.installed) continue;
    checks.push(integration.enabled
      ? {
          id: `integration.${integration.id}`, status: "ok",
          summary: `${integration.id} ${integration.version ?? ""} 已启用；${integration.transport === "none" ? "无专用适配" : "可通过 MCP 调用鲸群"}`.trim(),
        }
      : {
          id: `integration.${integration.id}`, status: "warn",
          summary: `${integration.id} 已安装但未启用`,
          remedy: "在 profile 中启用该插件后再验证工具可见性",
        });
  }
  checks.push({ id: "service.whaleFleet", status: "ok", summary: "whaleFleet v1 服务已提供" });

  const overall: FleetDoctorStatus = checks.some(check => check.status === "fail") ? "fail"
    : checks.some(check => check.status === "warn") ? "warn" : "ok";
  const nextActions = [...new Set(checks.flatMap(check => check.status !== "ok" && check.remedy !== undefined ? [check.remedy] : []))];
  return { overall, checkedAt: now.toISOString(), checks, integrations, nextActions };
}
