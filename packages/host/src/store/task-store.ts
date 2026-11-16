import type { TaskStatus } from "@dsh-fusion/core";

export interface CreateTaskInput {
  goal: string;
  nodeIds: string[];
  requestedByBotId?: string | undefined;
}

export function parseCreateTaskInput(input: unknown): CreateTaskInput {
  const candidate = input !== null && typeof input === "object" ? input as Partial<CreateTaskInput> : {};
  if (typeof candidate.goal !== "string" || candidate.goal.trim() === "") {
    throw new Error("goal is required");
  }
  if (!Array.isArray(candidate.nodeIds) || candidate.nodeIds.length === 0) {
    throw new Error("at least one nodeId is required");
  }
  return {
    goal: candidate.goal,
    nodeIds: candidate.nodeIds,
    ...(candidate.requestedByBotId === undefined ? {} : { requestedByBotId: candidate.requestedByBotId }),
  };
}

export const TERMINAL_TASK_STATES: TaskStatus[] = ["completed", "failed", "cancelled"];
