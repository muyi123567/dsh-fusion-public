import { useMemo, type CSSProperties } from "react";
import { CircleAlert, CircleCheckBig, Cpu, HardDrive, Play, RadioTower, Server } from "lucide-react";
import { taskStatusLabel } from "./task-model.js";
import type { FusionTaskViewProps } from "./task-view-registry.js";
import type { FusionTaskTopologyEntity } from "./task-topology.js";

function taskIcon(status: FusionTaskTopologyEntity["status"]) {
  if (status === "completed") return <CircleCheckBig size={11} />;
  if (status === "failed") return <CircleAlert size={11} />;
  return <Play size={11} />;
}

export function TaskSatellite({ topology, selectedTaskId, onSelectTask }: FusionTaskViewProps) {
  const tasksById = useMemo(
    () => new Map(topology.entities.filter((entity) => entity.kind === "task").map((entity) => [entity.id, entity])),
    [topology.entities],
  );
  const nodes = useMemo(
    () => topology.entities.filter((entity) => entity.kind === "node"),
    [topology.entities],
  );
  const rings = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
  const perRing = Math.ceil(nodes.length / rings);

  return (
    <section className="fusion-task-satellite" aria-label="卫星拓扑视图">
      <div className="fusion-task-satellite-scroll">
        <div className="fusion-task-satellite-stage">
          <div className="fusion-task-satellite-core">
            <RadioTower size={18} />
            <strong>DSH 控制面</strong>
            <small>{topology.taskIds.length} 个任务 · {topology.nodeIds.length} 个目标</small>
          </div>
          {nodes.map((node, index) => {
            const ring = Math.floor(index / perRing);
            const positionInRing = index % perRing;
            const angle = (positionInRing / perRing) * Math.PI * 2 + ring * 0.36;
            const radius = 240 + ring * 170;
            const nodeTasks = topology.taskIds
              .map((taskId) => tasksById.get(`task:${taskId}`))
              .filter((task): task is FusionTaskTopologyEntity => task !== undefined)
              .filter((task) => task.nodeIds.includes(node.id));
            return (
              <article
                className={
                  "fusion-task-satellite-node"
                  + (nodeTasks.some((task) => task.id === `task:${selectedTaskId}`) ? " is-linked" : "")
                }
                style={{ "--orbit-x": `${Math.cos(angle) * radius}px`, "--orbit-y": `${Math.sin(angle) * radius}px` } as CSSProperties}
                key={node.id}
                aria-label={`节点 ${node.label} ${nodeTasks.length} 个任务`}
              >
                <header>
                  <Server size={15} />
                  <div>
                    <strong>{node.label}<i className={`fusion-node-dot ${node.status}`} /></strong>
                    <small>{node.detail}</small>
                  </div>
                </header>
                <div className="fusion-task-satellite-metrics">
                  <span><Cpu size={12} /> {node.status === "online" ? "在线" : node.status === "degraded" ? "降级" : "离线"}</span>
                  <span><HardDrive size={12} /> {nodeTasks.length} 任务</span>
                </div>
                <ul>
                  {nodeTasks.map((task) => (
                    <li key={task.id}>
                      <button
                        type="button"
                        aria-label={`查看任务 ${task.id.slice("task:".length)}`}
                        aria-pressed={selectedTaskId === task.id.slice("task:".length)}
                        className={
                          "fusion-task-satellite-task"
                          + (selectedTaskId === task.id.slice("task:".length) ? " is-selected" : "")
                        }
                        onClick={() => onSelectTask(task.id.slice("task:".length))}
                      >
                        <strong>{task.label}</strong>
                        <span className={`fusion-status ${task.status}`}>{taskIcon(task.status)} {taskStatusLabel(task.status as Parameters<typeof taskStatusLabel>[0])}</span>
                      </button>
                    </li>
                  ))}
                  {nodeTasks.length === 0 ? <li className="fusion-task-satellite-idle">暂无可见任务</li> : null}
                </ul>
              </article>
            );
          })}
          {nodes.length === 0 ? (
            <div className="fusion-task-satellite-empty">当前筛选没有可展示的执行节点</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
