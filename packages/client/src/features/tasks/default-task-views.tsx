import { Network, Radar, Share2 } from "lucide-react";
import { TaskCanvas } from "./TaskCanvas.js";
import { TaskRadialTree } from "./TaskRadialTree.js";
import { TaskSatellite } from "./TaskSatellite.js";
import type { FusionTaskViewDefinition, FusionTaskViewProps } from "./task-view-registry.js";

function BridgeTaskView({ tasks, nodes, selectedTaskId, onSelectTask }: Omit<FusionTaskViewProps, "topology">) {
  return (
    <TaskCanvas
      tasks={tasks}
      nodes={nodes}
      {...(selectedTaskId === undefined ? {} : { selectedTaskId })}
      onSelectTask={onSelectTask}
    />
  );
}

export const defaultTaskViews: readonly FusionTaskViewDefinition[] = [
  {
    id: "bridge",
    label: "鹊桥画布",
    description: "按发起者、任务、节点和证据做四段泳道连线",
    group: "core",
    priority: 100,
    Icon: Network,
    Component: BridgeTaskView,
  },
  {
    id: "satellite",
    label: "卫星视图",
    description: "以 DSH 控制面为中心，按节点看任务轨道",
    group: "core",
    priority: 90,
    Icon: Radar,
    Component: TaskSatellite,
  },
  {
    id: "radial",
    label: "放射树",
    description: "以来源和任务做放射层级，快速追踪派发路径",
    group: "core",
    priority: 80,
    Icon: Share2,
    Component: TaskRadialTree,
  },
];
