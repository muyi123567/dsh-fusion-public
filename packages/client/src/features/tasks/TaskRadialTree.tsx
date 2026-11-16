import { useMemo } from "react";
import { Bot, CircleAlert, CircleCheckBig, Play, Server, UserRound } from "lucide-react";
import { taskStatusLabel } from "./task-model.js";
import type { FusionTaskViewProps } from "./task-view-registry.js";
import type { FusionTaskTopologyEntity } from "./task-topology.js";

function statusIcon(status: FusionTaskTopologyEntity["status"]) {
  if (status === "completed") return <CircleCheckBig size={11} />;
  if (status === "failed") return <CircleAlert size={11} />;
  return <Play size={11} />;
}

function taskStatus(status: FusionTaskTopologyEntity["status"]): Parameters<typeof taskStatusLabel>[0] {
  return status as Parameters<typeof taskStatusLabel>[0];
}

export function TaskRadialTree({ topology, selectedTaskId, onSelectTask }: FusionTaskViewProps) {
  const layout = useMemo(() => {
    const owners = topology.entities.filter((entity) => entity.kind === "owner");
    const tasks = topology.entities.filter((entity) => entity.kind === "task");
    const taskRadius = tasks.length === 0 ? 240 : Math.max(360, 220 + tasks.length * 14);
    const ownerRadius = Math.max(180, Math.round(taskRadius * 0.52));
    const positions = new Map<string, { x: number; y: number }>();
    const taskAngles = new Map<string, number>();
    tasks.forEach((task, index) => {
      const angle = ((index + 0.5) / Math.max(1, tasks.length)) * Math.PI * 2;
      taskAngles.set(task.id, angle);
      positions.set(task.id, {
        x: Math.cos(angle) * taskRadius,
        y: Math.sin(angle) * taskRadius,
      });
    });
    for (const owner of owners) {
      const angles = owner.taskIds
        .map((taskId) => taskAngles.get(`task:${taskId}`))
        .filter((angle): angle is number => angle !== undefined);
      const angle = angles.length === 0
        ? ((owners.indexOf(owner) + 0.5) / Math.max(1, owners.length)) * Math.PI * 2
        : angles.reduce((sum, value) => sum + value, 0) / angles.length;
      positions.set(owner.id, {
        x: Math.cos(angle) * ownerRadius,
        y: Math.sin(angle) * ownerRadius,
      });
    }
    const extent = taskRadius + 180;
    return { owners, tasks, positions, extent, taskRadius, ownerRadius };
  }, [topology.entities]);

  const nodeLabelsById = useMemo(() => new Map(
    topology.entities.filter((entity) => entity.kind === "node").map((entity) => [entity.id, entity.label]),
  ), [topology.entities]);
  const nodesById = useMemo(
    () => new Map(topology.entities.filter((entity) => entity.kind === "node").map((entity) => [entity.id, entity])),
    [topology.entities],
  );
  const nodePos = (id: string) => layout.positions.get(id) ?? { x: 0, y: 0 };
  const extent = layout.extent;

  return (
    <section className="fusion-task-radial" aria-label="放射树视图">
      <div className="fusion-task-radial-scroll">
        <svg
          className="fusion-task-radial-canvas"
          viewBox={`${-extent} ${-extent} ${extent * 2} ${extent * 2}`}
          role="presentation"
          focusable="false"
        >
          <circle className="fusion-task-radial-orbit is-inner" cx="0" cy="0" r={layout.ownerRadius} />
          <circle className="fusion-task-radial-orbit is-outer" cx="0" cy="0" r={layout.taskRadius} />
          {topology.ownerIds.map((ownerId) => {
            const owner = nodePos(ownerId);
            return <path className="fusion-task-radial-edge is-root" key={`root-${ownerId}`} d={`M 0 0 L ${owner.x} ${owner.y}`} />;
          })}
          {topology.edges.map((edge) => {
            const source = nodePos(edge.source);
            const target = nodePos(edge.target);
            return <path className={`fusion-task-radial-edge is-${edge.relation}`} key={edge.id} d={`M ${source.x} ${source.y} L ${target.x} ${target.y}`} />;
          })}
          {layout.owners.map((owner) => {
            const position = nodePos(owner.id);
            const ownerTaskIds = owner.taskIds.map((taskId) => `task:${taskId}`);
            return (
              <foreignObject className="fusion-task-radial-node-host" key={owner.id} x={position.x - 88} y={position.y - 38} width={176} height={76}>
                <article className={"fusion-task-radial-card is-owner" + (ownerTaskIds.includes(`task:${selectedTaskId}`) ? " is-linked" : "")}>
                  <span className="fusion-task-radial-icon">
                    {owner.id === "owner:operator" ? <UserRound size={13} /> : <Bot size={13} />}
                  </span>
                  <span className="fusion-task-radial-copy">
                    <strong>{owner.label}</strong>
                    <small>{owner.taskIds.length} 个任务</small>
                  </span>
                </article>
              </foreignObject>
            );
          })}
          <foreignObject className="fusion-task-radial-node-host" x={-110} y={-44} width={220} height={88}>
            <article className="fusion-task-radial-card is-root" aria-label="Fusion 控制面">
              <span className="fusion-task-radial-icon"><Server size={15} /></span>
              <span className="fusion-task-radial-copy">
                <strong>DSH 控制面</strong>
                <small>{topology.ownerIds.length} 来源 · {topology.taskIds.length} 任务 · {topology.nodeIds.length} 节点</small>
              </span>
            </article>
          </foreignObject>
          {layout.tasks.map((task) => {
            const position = nodePos(task.id);
            const taskId = task.id.slice("task:".length);
            const nodeText = task.nodeIds.map((nodeId) => nodeLabelsById.get(nodeId) ?? nodeId).join(" / ") || "未分配节点";
            return (
              <foreignObject className="fusion-task-radial-node-host" key={task.id} x={position.x - 104} y={position.y - 40} width={208} height={80}>
                <button
                  type="button"
                  aria-label={`查看任务 ${taskId}`}
                  aria-pressed={selectedTaskId === taskId}
                  className={"fusion-task-radial-card is-task" + (selectedTaskId === taskId ? " is-selected" : "")}
                  onClick={() => onSelectTask(taskId)}
                >
                  <span className="fusion-task-radial-task-head">
                    <strong>{task.label}</strong>
                    <span className={`fusion-status ${task.status}`}>{statusIcon(task.status)} {taskStatusLabel(taskStatus(task.status))}</span>
                  </span>
                  <small>
                    <Server size={10} /> {nodeText}
                  </small>
                </button>
              </foreignObject>
            );
          })}
          {layout.tasks.length === 0 ? (
            <foreignObject className="fusion-task-radial-node-host" x={-120} y={-36} width={240} height={72}>
              <article className="fusion-task-radial-card is-empty">没有符合筛选条件的任务</article>
            </foreignObject>
          ) : null}
        </svg>
        <dl className="fusion-task-radial-legend">
          <div><dt>来源</dt><dd>{topology.ownerIds.length}</dd></div>
          <div><dt>任务</dt><dd>{topology.taskIds.length}</dd></div>
          <div><dt>节点</dt><dd>{topology.nodeIds.length}</dd></div>
          <div><dt>证据组</dt><dd>{topology.evidenceGroupIds.length}</dd></div>
        </dl>
      </div>
    </section>
  );
}
