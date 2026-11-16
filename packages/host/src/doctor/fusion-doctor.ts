import type { DshCompatibilityReport } from "@dsh-fusion/core";

export type FusionDoctorStatus = "ok" | "degraded" | "failed";

export interface FusionDoctorCheck {
  id: string;
  ok: boolean;
  status: FusionDoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface FusionDoctorReport {
  status: FusionDoctorStatus;
  checkedAt: string;
  checks: FusionDoctorCheck[];
  summary: {
    total: number;
    ok: number;
    degraded: number;
    failed: number;
  };
}

export interface FusionDoctorProvider {
  state: string;
  message?: string;
  error?: { code?: string; message?: string };
}

export interface FusionDoctorNode {
  id: string;
  name: string;
  status: string;
  configState: string;
  providerId: string;
}

export interface FusionDoctorTask {
  id: string;
  status: string;
  targetNodeIds: string[];
  childTaskRefs?: Array<{ id: string; targetNodeIds: string[] }>;
}

export interface FusionDoctorLedger {
  path?: string;
  readable: boolean;
  taskCount: number;
  error?: string;
}

export interface FusionDoctorRemoteConfig {
  state: string;
  ok: boolean;
  message?: string;
  activeHash?: string;
}

export interface FusionDoctorFleet {
  /** Epoch ms of the fleet read this report is based on. */
  checkedAt: number;
  stale: boolean;
  inspect?: {
    totals: { attempts: number; failures: number };
    lastRound: {
      round: number;
      attempts: number;
      failures: number;
      peakQueueDepth: number;
      startedAt: number;
      durationMs: number | undefined;
    } | undefined;
  };
}

export interface FusionDoctorInput {
  dshCompatibility: DshCompatibilityReport;
  providers: Record<string, FusionDoctorProvider | undefined>;
  nodes: readonly FusionDoctorNode[];
  /** Fleet observability of the read behind this report, when a fleet is configured. */
  fleet?: FusionDoctorFleet;
  /**
   * The node ids the deployment is configured to run.
   *
   * The observed node list shrinks when a provider cannot be reached, so it
   * cannot be the denominator of a reachability check. This is the fleet
   * that was asked for; the observed list is what answered.
   */
  configuredNodeIds?: readonly string[];
  tasks: readonly FusionDoctorTask[];
  ledger?: FusionDoctorLedger;
  remoteConfig?: FusionDoctorRemoteConfig;
  knownIncompatibilities?: ReadonlyArray<{ id: string; message: string }>;
  now?: () => number;
}

function worst(statuses: FusionDoctorStatus[]): FusionDoctorStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

function providerStatus(provider: FusionDoctorProvider | undefined): FusionDoctorStatus {
  if (provider === undefined) return "degraded";
  if (provider.state === "connected") return "ok";
  if (provider.state === "degraded") return "degraded";
  if (provider.state === "not-configured") return "degraded";
  return "failed";
}

function providerMessage(provider: FusionDoctorProvider | undefined): string {
  if (provider === undefined) return "provider not configured";
  const detail = provider.message ?? provider.error?.message;
  if (detail !== undefined && detail.trim() !== "") return detail.trim();
  return `provider state: ${provider.state}`;
}

function check(
  id: string,
  status: FusionDoctorStatus,
  message: string,
  details?: Record<string, unknown>,
): FusionDoctorCheck {
  return {
    id,
    ok: status === "ok",
    status,
    message,
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * Aggregates every health signal Fusion knows about into one report. The
 * doctor never throws: a failing signal becomes a failed check so the caller
 * always receives a structured, renderable verdict.
 */
export function buildFusionDoctorReport(input: FusionDoctorInput): FusionDoctorReport {
  const checks: FusionDoctorCheck[] = [];

  const compatibility = input.dshCompatibility;
  const compatibilityStatus = compatibility.state === "verified"
    ? "ok"
    : compatibility.state === "unsupported"
      ? "failed"
      : "degraded";
  const compatibilityMessage = compatibility.state === "verified"
    ? `DSH ${compatibility.version ?? "unknown"} is verified`
    : compatibility.state === "untested"
      ? `DSH ${compatibility.version ?? "unknown"} is untested; recommended ${compatibility.matrix.recommended}`
      : compatibility.state === "unsupported"
        ? `DSH ${compatibility.version ?? "unknown"} is unsupported`
        : `DSH version is unknown (${compatibility.reasonCode})`;
  checks.push(check(
    "plugin.dsh-version",
    compatibilityStatus,
    compatibilityMessage,
    {
      state: compatibility.state,
      ...(compatibility.version === undefined ? {} : { version: compatibility.version }),
      source: compatibility.source,
      reasonCode: compatibility.reasonCode,
      recommendedVersion: compatibility.matrix.recommended,
      testedVersions: compatibility.matrix.tested,
    },
  ));

  for (const [providerId, provider] of Object.entries(input.providers)) {
    const status = providerStatus(provider);
    checks.push(check(
      `provider.${providerId}`,
      status,
      providerMessage(provider),
      { providerId, state: provider?.state ?? "not-configured" },
    ));
  }

  const offlineNodes = input.nodes.filter((node) => node.status !== "online");
  const configuredNodeIds = input.configuredNodeIds ?? input.nodes.map((node) => node.id);
  // A node that was configured but never observed is unreachable, not absent.
  const unobservedNodeIds = configuredNodeIds.filter(
    (nodeId) => !input.nodes.some((node) => node.id === nodeId),
  );
  const configuredCount = new Set(configuredNodeIds).size;
  const driftNodes = input.nodes.filter((node) => node.configState === "drift");
  const unknownConfigNodes = input.nodes.filter((node) => node.configState === "unknown");
  checks.push(check(
    "nodes.online",
    offlineNodes.length === 0 && unobservedNodeIds.length === 0 ? "ok" : "degraded",
    offlineNodes.length === 0 && unobservedNodeIds.length === 0
      ? `${configuredCount} node(s) online`
      : `${offlineNodes.length + unobservedNodeIds.length} of ${configuredCount} node(s) not online`,
    {
      total: configuredCount,
      observed: input.nodes.length,
      online: input.nodes.length - offlineNodes.length,
      offline: offlineNodes.filter((node) => node.status === "offline").map((node) => node.id),
      degraded: offlineNodes.filter((node) => node.status === "degraded").map((node) => node.id),
      unobserved: unobservedNodeIds,
    },
  ));
  checks.push(check(
    "config.drift",
    driftNodes.length === 0 ? "ok" : "degraded",
    driftNodes.length === 0
      ? "no drifted node configuration"
      : `${driftNodes.length} node(s) drifted`,
    { drift: driftNodes.map((node) => node.id), unverified: unknownConfigNodes.map((node) => node.id) },
  ));

  const nodeIds = new Set(input.nodes.map((node) => node.id));
  const orphanChildren = input.tasks.flatMap((task) =>
    (task.childTaskRefs ?? [])
      .filter((child) => child.targetNodeIds.some((nodeId) => !nodeIds.has(nodeId)))
      .map((child) => ({ parent: task.id, child: child.id })),
  );
  const failedTasks = input.tasks.filter((task) => task.status === "failed");
  checks.push(check(
    "tasks.integrity",
    orphanChildren.length === 0 ? "ok" : "degraded",
    orphanChildren.length === 0
      ? `${input.tasks.length} task(s) with intact child references`
      : `${orphanChildren.length} child reference(s) point at unknown nodes`,
    {
      orphans: orphanChildren,
      failed: failedTasks.map((task) => task.id),
      unknownNodeIds: [
        ...new Set(
          input.tasks.flatMap((task) =>
            (task.childTaskRefs ?? [])
              .flatMap((child) => child.targetNodeIds)
              .filter((nodeId) => !nodeIds.has(nodeId)),
          ),
        ),
      ],
    },
  ));

  if (input.ledger !== undefined) {
    checks.push(check(
      "tasks.ledger",
      input.ledger.readable ? "ok" : "failed",
      input.ledger.readable
        ? `ledger readable with ${input.ledger.taskCount} task(s)`
        : `ledger unreadable: ${input.ledger.error ?? "unknown error"}`,
      {
        ...(input.ledger.path === undefined ? {} : { path: input.ledger.path }),
        taskCount: input.ledger.taskCount,
      },
    ));
  }

  if (input.remoteConfig !== undefined) {
    const configOk = input.remoteConfig.ok && input.remoteConfig.state === "current";
    checks.push(check(
      "config.remote",
      configOk ? "ok" : "degraded",
      configOk
        ? "remote node configuration is current"
        : `remote node configuration state: ${input.remoteConfig.state}`,
      {
        state: input.remoteConfig.state,
        ...(input.remoteConfig.activeHash === undefined
          ? {}
          : { activeHash: input.remoteConfig.activeHash }),
      },
    ));
  }

  if (input.fleet !== undefined) {
    const checkedAtIso = new Date(input.fleet.checkedAt).toISOString();
    checks.push(check(
      "fleet.observability",
      input.fleet.stale ? "degraded" : "ok",
      input.fleet.stale
        ? `fleet data is stale (checked at ${checkedAtIso})`
        : `fleet data checked at ${checkedAtIso}`,
      {
        checkedAt: checkedAtIso,
        stale: input.fleet.stale,
        ...(input.fleet.inspect === undefined ? {} : { inspect: input.fleet.inspect }),
      },
    ));
  }

  for (const known of input.knownIncompatibilities ?? []) {
    checks.push(check(`upstream.${known.id}`, "degraded", known.message, { id: known.id }));
  }

  const summary = {
    total: checks.length,
    ok: checks.filter((entry) => entry.status === "ok").length,
    degraded: checks.filter((entry) => entry.status === "degraded").length,
    failed: checks.filter((entry) => entry.status === "failed").length,
  };
  return {
    status: worst(checks.map((entry) => entry.status)),
    checkedAt: new Date((input.now ?? Date.now)()).toISOString(),
    checks,
    summary,
  };
}
