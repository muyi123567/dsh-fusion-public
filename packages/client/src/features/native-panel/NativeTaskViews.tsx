import { useEffect, useMemo, type ReactNode } from "react";
import type { FusionTaskViewProps } from "@dsh-fusion/core";
import { buildTaskTopology } from "../tasks/task-topology.js";
import { TaskViewErrorBoundary } from "../tasks/TaskViewErrorBoundary.js";
import { useTaskViewDefinitions } from "../tasks/task-view-registry.js";

interface NativeTaskViewsProps extends Pick<FusionTaskViewProps,
  "tasks" | "nodes" | "selectedTaskId" | "onSelectTask" | "onDispatchTask" | "onCancelTask"> {
  view: string;
  onViewChange: (id: string) => void;
  connectionStale: boolean;
  allowExtensionActions?: boolean;
  children: ReactNode;
}

/** Existing collection-view contract, with the native list as its default. */
export function NativeTaskViews({
  view, onViewChange, tasks, nodes, selectedTaskId, onSelectTask,
  connectionStale, allowExtensionActions = false, onDispatchTask, onCancelTask, children,
}: NativeTaskViewsProps) {
  const definitions = useTaskViewDefinitions().filter(definition => definition.group !== "core");
  const active = definitions.find(definition => definition.id === view);
  const topology = useMemo(() => buildTaskTopology(tasks, nodes), [tasks, nodes]);
  useEffect(() => { if (view && !active) onViewChange(""); }, [view, active, onViewChange]);
  const props: FusionTaskViewProps & { connectionStale: boolean } = {
    tasks, nodes, topology, onSelectTask, connectionStale,
    ...(selectedTaskId === undefined ? {} : { selectedTaskId }),
    ...(allowExtensionActions && !connectionStale && active?.actions?.includes("dispatch") && onDispatchTask ? { onDispatchTask } : {}),
    ...(allowExtensionActions && !connectionStale && active?.actions?.includes("cancel") && onCancelTask ? { onCancelTask } : {}),
  };
  const View = active?.Component;
  return <>
    {definitions.length > 0 && <label style={{ display: "flex", alignItems: "center", gap: 6, padding: "0 8px 8px" }}>
      任务视图
      <select aria-label="任务视图" value={active?.id ?? ""} onChange={event => onViewChange(event.currentTarget.value)}>
        <option value="">原生列表</option>
        {definitions.map(definition => <option key={definition.id} value={definition.id}>{definition.label}</option>)}
      </select>
    </label>}
    {active && View ? <TaskViewErrorBoundary key={active.id} extensionId={active.id} onReset={() => onViewChange("")}>
      <View {...props} />
    </TaskViewErrorBoundary> : children}
  </>;
}
