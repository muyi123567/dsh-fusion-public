import type {
  ProviderHealthState,
  ProviderKind,
  ProviderStatus,
} from "./types.js";

export interface ProviderStatusInput {
  configured?: boolean;
  state?: ProviderHealthState;
  message?: string;
  version?: string;
  checkedAt?: number;
}

export function createProviderStatus(input: ProviderStatusInput = {}): ProviderStatus {
  const checkedAt = input.checkedAt ?? Date.now();
  if (input.configured === false) {
    return { state: "not-configured", checkedAt };
  }

  const status: ProviderStatus = {
    state: input.state ?? "offline",
    checkedAt,
  };
  if (input.message !== undefined) status.message = input.message;
  if (input.version !== undefined) status.version = input.version;
  return status;
}

export interface FusionProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  health(): Promise<ProviderStatus>;
  start(): Promise<void>;
  stop(): Promise<void>;
}
