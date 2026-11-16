import type {
  FusionProvider,
  NodeRecord,
  ProviderStatus,
  TaskRecord,
  ExecCapabilityObservation,
} from "@dsh-fusion/core";

export interface FleetDispatchInput {
  goal: string;
  nodeIds: string[];
  requestedByBotId?: string;
  command?: string;
  idempotencyKey?: string;
  /** Deterministic provider task id, supplied when retrying one dispatch intent. */
  taskId?: string;
  dispatchFingerprint?: string;
}

export interface FleetProvider extends FusionProvider {
  readonly kind: "fleet";
  listNodes(): Promise<NodeRecord[]>;
  /**
   * The nodes this provider owns, without probing them.
   *
   * A provider that cannot be reached still has a known identity. Reporting
   * it lets the caller keep the node visible as offline instead of dropping
   * it, so an unreachable node is never mistaken for an absent one.
   */
  describeNodes?(): NodeRecord[];
  /** Explicit read-only observation; does not create a job or execute user input. */
  probeExecCapability?(): Promise<ExecCapabilityObservation>;
  dispatch(input: FleetDispatchInput): Promise<TaskRecord>;
  cancel(taskId: string): Promise<void>;
}

export interface FleetProviderHealthInput {
  ok: boolean;
  workers?: number;
  message?: string;
  version?: string;
}

export type FleetHealthProbe = () => Promise<FleetProviderHealthInput>;

export function statusFromFleetProbe(input: FleetProviderHealthInput): ProviderStatus {
  let state: ProviderStatus["state"] = "offline";
  if (input.ok) {
    state = input.workers === 0 ? "degraded" : "connected";
  }

  return {
    state,
    checkedAt: Date.now(),
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.version === undefined ? {} : { version: input.version }),
  };
}
