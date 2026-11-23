import type { FleetDriftReport, FleetHostManifest } from "./fleet-environment.js";

export type FleetPlanAction =
  | "install" | "update" | "enable" | "restore-patch" | "checkout" | "clean"
  | "credential" | "upgrade-host" | "configure" | "review";

export interface FleetPlanStep {
  id: string;
  action: FleetPlanAction;
  target: string;
  risk: "low" | "medium" | "high";
  requiresRestart: boolean;
  reason: string;
}

export interface FleetPlanReport {
  contractVersion: 1;
  hostId: string;
  expectedDigest: string;
  observedDigest: string;
  overall: "ready" | "plan" | "unknown";
  steps: FleetPlanStep[];
  note?: string;
}

export function planFleetAlignment(
  expected: FleetHostManifest,
  observed: FleetHostManifest,
  drift: FleetDriftReport,
): FleetPlanReport {
  if (drift.overall === "match") {
    return { contractVersion: 1, hostId: observed.hostId, expectedDigest: expected.environmentDigest,
      observedDigest: observed.environmentDigest, overall: "ready", steps: [] };
  }
  if (drift.overall === "unknown") {
    return { contractVersion: 1, hostId: observed.hostId, expectedDigest: expected.environmentDigest,
      observedDigest: observed.environmentDigest, overall: "unknown", steps: [],
      ...(drift.reason === undefined ? {} : { note: drift.reason }) };
  }

  const steps: FleetPlanStep[] = [];
  const seen = new Set<string>();
  const add = (step: Omit<FleetPlanStep, "id">) => {
    const key = `${step.action}:${step.target}`;
    if (seen.has(key)) return;
    seen.add(key);
    steps.push({ ...step, id: key });
  };
  const expectedBundle = (name: string) => expected.bundles.find(bundle => bundle.name === name);

  for (const item of drift.items) {
    const target = /\[([^\]]+)\]/u.exec(item.path)?.[1] ?? item.path;
    switch (item.code) {
      case "bundle.missing":
        add({ action: "install", target, risk: "medium", requiresRestart: true,
          reason: `安装 ${target}${expectedBundle(target)?.version === undefined ? "" : `@${expectedBundle(target)!.version}`}` });
        break;
      case "bundle.version":
        add({ action: "update", target, risk: "medium", requiresRestart: true,
          reason: `更新到 ${String(item.expected ?? "锁定版本")}` });
        break;
      case "bundle.enabled":
        add({ action: "enable", target, risk: "low", requiresRestart: true, reason: "在 profile 中启用该 bundle" });
        break;
      case "bundle.availability":
        add({ action: "install", target, risk: "medium", requiresRestart: true, reason: "重新安装不可读的 bundle" });
        break;
      case "bundle.digest":
        add({ action: "review", target, risk: "high", requiresRestart: false, reason: "bundle 内容与期望摘要不一致" });
        break;
      case "patch.missing":
      case "patch.digest":
        add({ action: "restore-patch", target: item.path, risk: "high", requiresRestart: true, reason: "恢复锁定的 profile/home patch" });
        break;
      case "workspace.commit":
        add({ action: "checkout", target, risk: "medium", requiresRestart: false,
          reason: `检出 ${String(item.expected ?? "期望提交")}` });
        break;
      case "workspace.dirty":
        add({ action: "clean", target, risk: "high", requiresRestart: false, reason: "工作区有未提交改动，先人工确认/保存" });
        break;
      case "workspace.missing":
        add({ action: "review", target, risk: "high", requiresRestart: false, reason: "缺失锁定的工作区" });
        break;
      case "secret.missing":
        add({ action: "credential", target: String(item.expected ?? target), risk: "low", requiresRestart: false,
          reason: "在目标主机提供缺失凭据；不要把值发到聊天" });
        break;
      case "runtime.version":
        add({ action: "upgrade-host", target: "dsh", risk: "high", requiresRestart: true,
          reason: `匹配 DSH ${String(item.expected ?? "期望版本")}` });
        break;
      case "runtime.platform":
      case "runtime.arch":
        add({ action: "review", target: item.path, risk: "high", requiresRestart: true, reason: "目标平台/架构不一致" });
        break;
      case "capability.missing":
      case "capability.changed":
        add({ action: "configure", target, risk: "medium", requiresRestart: false, reason: "配置缺失或变化的能力" });
        break;
      case "provider.missing":
      case "mcp.missing":
        add({ action: "configure", target: item.expected === undefined ? target : String(item.expected), risk: "medium", requiresRestart: true, reason: "配置缺失的 provider/MCP 服务器" });
        break;
      default:
        add({ action: "review", target: item.path, risk: "high", requiresRestart: false, reason: `${item.code} 需人工确认` });
    }
  }

  return {
    contractVersion: 1, hostId: observed.hostId, expectedDigest: expected.environmentDigest,
    observedDigest: observed.environmentDigest, overall: steps.length === 0 ? "unknown" : "plan", steps,
  };
}
