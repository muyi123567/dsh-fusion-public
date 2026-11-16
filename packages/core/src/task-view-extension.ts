import type { FusionTaskTopology } from "./task-view.js";
import type { NodeRecord, TaskRecord } from "./types.js";

export type FusionTaskViewAction = "dispatch" | "cancel";

export interface FusionTaskViewProps {
  topology: FusionTaskTopology;
  tasks: readonly TaskRecord[];
  nodes: readonly NodeRecord[];
  selectedTaskId?: string;
  onSelectTask: (taskId: string) => void;
  onDispatchTask?: ((input: {
    goal: string;
    command: string;
    nodeIds: string[];
    idempotencyKey?: string | undefined;
  }) => Promise<TaskRecord | void>) | undefined;
  onCancelTask?: ((taskId: string) => void | Promise<void>) | undefined;
}

export interface FusionTaskViewDefinition<TComponent = unknown, TIcon = unknown> {
  id: string;
  label: string;
  description?: string;
  group?: "core" | "extension";
  priority?: number;
  actions?: readonly FusionTaskViewAction[];
  Icon?: TIcon;
  Component: TComponent;
}
