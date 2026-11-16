import type { TaskStatus } from "./types.js";

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type FusionEvent =
  | { seq: number; type: "provider.status"; providerId: string; state: string; at: string }
  | { seq: number; type: "bot.updated"; botId: string; at: string }
  | { seq: number; type: "session.updated"; sessionId: string; at: string }
  | { seq: number; type: "node.updated"; nodeId: string; at: string }
  | { seq: number; type: "task.updated"; taskId: string; status: TaskStatus; at: string }
  | { seq: number; type: "config.updated"; nodeId: string; at: string }
  | { seq: number; type: "state.updated"; scope: string; at: string };

export type FusionEventInput = DistributiveOmit<FusionEvent, "seq" | "at">;
