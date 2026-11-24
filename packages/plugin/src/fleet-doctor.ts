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
  subsystems?: {
    connectors?: { providers: number; configured: number; invalid: number };
    notifications?: { adapters: number; invalid: number; failed: number; unknown: number };
    presets?: { total: number; installed: number };
    backups?: { count: number; latestAt?: string };
    trust?: { entries: number; untrusted: number; invalid: number; mode: string };
    alignment?: { pending: number; manual: number; failed: number };
    dispatch?: { pending: number };
  };
}

const INTEGRATIONS = [
  { id: "ds-bot", package: "ds-bot", transport: "mcp" as const },
  { id: "dsh-im", package: "@xmanrui/dsh-im", transport: "mcp" as const },
  { id: "dsh-qqbot", package: "@tencent-connect/dsh-qqbot", transport: "mcp" as const },
  { id: "modlens", package: "@liustack/modlens", transport: "none" as const },
  { id: "agent-teams", package: "@nanmicoder/dsh-agent-teams", transport: "none" as const },
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

  const subsystems = input.subsystems;
  if (subsystems?.connectors !== undefined) {
    const value = subsystems.connectors;
    checks.push(value.invalid > 0
      ? {
          id: "connectors.instances", status: "warn",
          summary: `${value.invalid} 个云盘连接器配置无效`,
          remedy: "检查凭据环境变量、URL 与 provider 字段",
        }
      : value.configured > 0
        ? { id: "connectors.instances", status: "ok", summary: `${value.configured} 个云盘连接器就绪（${value.providers} 个 provider）` }
        : {
            id: "connectors.instances", status: "warn", summary: "未配置云盘连接器",
            remedy: "在 fleetConnectors.connectors 中配置 Google Drive、OneDrive、Dropbox 或 WebDAV",
          });
  }
  if (subsystems?.notifications !== undefined) {
    const value = subsystems.notifications;
    checks.push(value.invalid > 0 || value.failed > 0
      ? {
          id: "notifications.adapters", status: "warn",
          summary: `${value.invalid} 个无效、${value.failed} 条失败、${value.unknown} 条未知通知`,
          remedy: "在面板测试通知适配器并检查地址/凭据；unknown 不要自动重试",
        }
      : value.adapters > 0
        ? { id: "notifications.adapters", status: "ok", summary: `${value.adapters} 个通知适配器` }
        : {
            id: "notifications.adapters", status: "warn", summary: "未配置通知适配器",
            remedy: "配置 dsh-im、Slack、飞书、钉钉、Telegram、Discord 或 webhook",
          });
  }
  if (subsystems?.presets !== undefined) {
    const value = subsystems.presets;
    checks.push(value.installed > 0
      ? { id: "presets.skills", status: "ok", summary: `已安装 ${value.installed} 个 Skill 预设` }
      : {
          id: "presets.skills", status: "warn", summary: "未安装鲸群 Skill 预设",
          remedy: "在面板“预设与热备”安装 whale-fleet-ops",
        });
  }
  if (subsystems?.backups !== undefined) {
    const value = subsystems.backups;
    checks.push(value.count > 0
      ? { id: "backup.snapshots", status: "ok", summary: `${value.count} 份配置快照${value.latestAt === undefined ? "" : `，最近 ${value.latestAt}`}` }
      : {
          id: "backup.snapshots", status: "warn", summary: "没有配置快照",
          remedy: "在面板“预设与热备”创建快照，或开启 fleetBackup.auto",
        });
  }
  if (subsystems?.trust !== undefined) {
    const value = subsystems.trust;
    checks.push(value.untrusted > 0 || value.invalid > 0
      ? {
          id: "trust.hosts", status: "warn",
          summary: `${value.untrusted} 台未信任、${value.invalid} 台签名异常（${value.mode}）`,
          remedy: "在面板“主机信任”核对公钥；不要接受 key-mismatch",
        }
      : value.entries > 0
        ? { id: "trust.hosts", status: "ok", summary: `${value.entries} 台远端主机已信任（${value.mode}）` }
        : {
            id: "trust.hosts", status: "warn", summary: `尚无远端信任条目（${value.mode}）`,
            remedy: "把远端 host-public.pem 放到 fleet/hosts/<hostId>.pub.pem 后信任",
          });
  }
  if (subsystems?.alignment !== undefined) {
    const value = subsystems.alignment;
    checks.push(value.failed > 0
      ? {
          id: "alignment.requests", status: "warn",
          summary: `${value.failed} 个对齐请求失败`,
          remedy: "查看 failed 请求的 results/rollback",
        }
      : value.pending > 0 || value.manual > 0
        ? {
            id: "alignment.requests", status: "warn",
            summary: `${value.pending} 个待批准、${value.manual} 个需人工`,
            remedy: "在面板“环境对齐”批准或处理人工步骤",
          }
        : { id: "alignment.requests", status: "ok", summary: "没有待处理对齐请求" });
  }
  if (subsystems?.dispatch !== undefined && subsystems.dispatch.pending > 0) {
    checks.push({
      id: "dispatch.pending", status: "warn",
      summary: `${subsystems.dispatch.pending} 个待审批派发`,
      remedy: "在面板“待审批派发”批准或拒绝",
    });
  }

  const overall: FleetDoctorStatus = checks.some(check => check.status === "fail") ? "fail"
    : checks.some(check => check.status === "warn") ? "warn" : "ok";
  const nextActions = [...new Set(checks.flatMap(check => check.status !== "ok" && check.remedy !== undefined ? [check.remedy] : []))];
  return { overall, checkedAt: now.toISOString(), checks, integrations, nextActions };
}
