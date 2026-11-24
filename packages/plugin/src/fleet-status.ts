import type { WhaleFleetServiceV1 } from "./fleet-service.js";
import type { WhaleConnectorServiceV1 } from "./cloud-connectors.js";
import type { WhaleNotificationServiceV1 } from "./fleet-notification-adapters.js";
import type { WhalePresetServiceV1 } from "./fleet-presets.js";
import type { WhaleBackupServiceV1 } from "./fleet-backup.js";
import type { WhaleAlignmentServiceV1 } from "./fleet-alignment.js";
import type { FleetDispatchRequestService } from "./fleet-dispatch-requests.js";

export interface FleetStatusReport {
  contractVersion: 1;
  checkedAt: string;
  host: {
    hostId: string;
    displayName: string;
    digest: string;
    overall: string;
    stale: boolean;
    signed: boolean;
    verified: boolean;
    trust: string;
  };
  hosts: { total: number; drift: number; unknown: number; stale: number; untrusted: number };
  pending: { dispatch: number; alignment: number };
  systems: {
    connectors: { providers: number; configured: number; invalid: number };
    notifications: { adapters: number; invalid: number; failed: number; unknown: number };
    presets: { total: number; installed: number };
    backups: { count: number; latestAt?: string };
    trust: { entries: number; untrusted: number; invalid: number; mode: string };
    alignment: { pending: number; manual: number; failed: number };
  };
  nextActions: string[];
}

export interface WhaleStatusServiceV1 {
  readonly contractVersion: 1;
  status(): Promise<FleetStatusReport>;
}

export interface FleetStatusServiceOptions {
  fleet: Pick<WhaleFleetServiceV1, "manifest" | "listHosts"> & Partial<Pick<WhaleFleetServiceV1, "trustReport">>;
  connectors?: Pick<WhaleConnectorServiceV1, "catalog" | "instances">;
  notifications?: Pick<WhaleNotificationServiceV1, "adapters" | "receipts">;
  presets?: Pick<WhalePresetServiceV1, "list">;
  backups?: Pick<WhaleBackupServiceV1, "list">;
  alignment?: Pick<WhaleAlignmentServiceV1, "list">;
  requests?: Pick<FleetDispatchRequestService, "list">;
  now?: () => number;
}

export function createFleetStatusService(options: FleetStatusServiceOptions): WhaleStatusServiceV1 {
  const now = options.now ?? Date.now;
  return {
    contractVersion: 1,
    async status() {
      const local = await options.fleet.manifest();
      const hosts = await options.fleet.listHosts();
      const trust = options.fleet.trustReport === undefined ? undefined : await options.fleet.trustReport();
      const connectors = options.connectors?.instances() ?? [];
      const adapters = options.notifications?.adapters() ?? [];
      const receipts = options.notifications?.receipts().slice(-50) ?? [];
      const presets = options.presets?.list() ?? [];
      const backups = options.backups?.list() ?? [];
      const alignment = options.alignment?.list() ?? [];
      const dispatch = options.requests === undefined ? [] : await options.requests.list();
      const localSummary = hosts.find(host => host.hostId === local.hostId);

      const pendingAlignment = alignment.filter(request => request.status === "pending").length;
      const manualAlignment = alignment.filter(request => request.status === "manual-required" || request.status === "partial").length;
      const failedAlignment = alignment.filter(request => request.status === "failed").length;
      const report: FleetStatusReport = {
        contractVersion: 1,
        checkedAt: new Date(now()).toISOString(),
        host: {
          hostId: local.hostId,
          displayName: local.displayName,
          digest: local.environmentDigest,
          overall: localSummary?.overall ?? "unknown",
          stale: localSummary?.stale ?? false,
          signed: localSummary?.signed ?? local.signature.alg === "ed25519",
          verified: localSummary?.verified ?? false,
          trust: localSummary?.trust ?? "unknown",
        },
        hosts: {
          total: hosts.length,
          drift: hosts.filter(host => host.overall === "drift").length,
          unknown: hosts.filter(host => host.overall === "unknown").length,
          stale: hosts.filter(host => host.stale).length,
          untrusted: hosts.filter(host => host.trust === "untrusted" || host.trust === "invalid" || host.trust === "key-mismatch").length,
        },
        pending: {
          dispatch: dispatch.filter(request => request.status === "pending").length,
          alignment: pendingAlignment,
        },
        systems: {
          connectors: {
            providers: options.connectors?.catalog().length ?? 0,
            configured: connectors.filter(instance => instance.state === "configured").length,
            invalid: connectors.filter(instance => instance.state === "invalid").length,
          },
          notifications: {
            adapters: adapters.length,
            invalid: adapters.filter(adapter => adapter.state === "invalid").length,
            failed: receipts.filter(receipt => receipt.status === "failed").length,
            unknown: receipts.filter(receipt => receipt.status === "unknown").length,
          },
          presets: {
            total: presets.length,
            installed: presets.filter(preset => preset.status?.state === "installed").length,
          },
          backups: {
            count: backups.length,
            ...(backups[0]?.createdAt === undefined ? {} : { latestAt: backups[0].createdAt }),
          },
          trust: {
            entries: trust?.entries.length ?? 0,
            untrusted: trust?.hosts.filter(host => host.trust === "untrusted").length ?? 0,
            invalid: trust?.hosts.filter(host => host.trust === "invalid" || host.trust === "key-mismatch").length ?? 0,
            mode: trust?.mode ?? "unknown",
          },
          alignment: {
            pending: pendingAlignment,
            manual: manualAlignment,
            failed: failedAlignment,
          },
        },
        nextActions: [],
      };
      report.nextActions = actionsFor(report);
      return report;
    },
  };
}

function actionsFor(report: FleetStatusReport): string[] {
  const actions: string[] = [];
  if (report.host.trust === "untrusted" || report.hosts.untrusted > 0) {
    actions.push("处理未信任或签名无效的远端清单");
  }
  if (report.hosts.unknown > 0) actions.push("配置期望环境或刷新状态未知的主机");
  if (report.hosts.drift > 0) actions.push("查看漂移并生成对齐计划");
  if (report.pending.dispatch > 0 || report.pending.alignment > 0) actions.push("等待人工批准待处理请求");
  if (report.systems.alignment.failed > 0) actions.push("检查失败的对齐请求与回滚结果");
  if (report.systems.connectors.invalid > 0) actions.push("修复无效云盘连接器配置");
  if (report.systems.notifications.invalid > 0 || report.systems.notifications.failed > 0) {
    actions.push("测试或修复通知适配器");
  }
  if (report.systems.presets.installed === 0) actions.push("安装鲸群运维 Skill 预设");
  if (report.systems.backups.count === 0) actions.push("创建第一份配置快照");
  return actions;
}
