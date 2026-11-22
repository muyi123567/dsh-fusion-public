import { useMemo } from "react";
import { Ban, Check, CircleAlert, CircleDashed, CircleDot, CirclePause, Clock3, LoaderCircle } from "lucide-react";
import type { AgentTeamRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { nativeTaskFact, nativeTaskLabel, nativeTaskStatus, nativeTaskTime } from "./native-task-status.js";
import styles from "./native-task-list.module.css";

const groups = [
  ["attention", "需关注"],
  ["running", "进行中"],
  ["claimed", "已认领"],
  ["queued", "稍后"],
  ["completed", "已回报完成"],
  ["cancelled", "已取消"],
] as const;

const statusIcons = {
  failed: CircleAlert, blocked: CirclePause, verifying: CircleDashed,
  running: LoaderCircle, claimed: CircleDot, queued: Clock3, completed: Check, cancelled: Ban,
};

type TaskGroup = (typeof groups)[number][0];

function taskGroup(status: string): TaskGroup {
  switch (status) {
    case "failed":
    case "verifying":
    case "blocked": return "attention";
    case "running":
    case "claimed":
    case "completed":
    case "cancelled": return status;
    default: return "queued";
  }
}

interface NativeTaskListProps {
  tasks: readonly TaskRecord[];
  nodes: readonly NodeRecord[];
  teams: readonly AgentTeamRecord[];
  blockedTaskIds?: ReadonlySet<string>;
  selectedId?: string;
  onSelect: (id: string) => void;
  rowRefs: Map<string, HTMLButtonElement>;
}

export function NativeTaskList({ tasks, nodes, teams, blockedTaskIds, selectedId, onSelect, rowRefs }: NativeTaskListProps) {
  const nodeNames = useMemo(() => new Map(nodes.map(node => [node.id, node.name])), [nodes]);
  const membershipNames = useMemo(() => {
    const namesByTask = new Map<string, Set<string>>();
    for (const team of teams) {
      for (const id of team.taskIds) {
        const names = namesByTask.get(id) ?? new Set<string>();
        names.add(team.name);
        namesByTask.set(id, names);
      }
    }
    return namesByTask;
  }, [teams]);

  const grouped = new Map<TaskGroup, { task: TaskRecord; status: string; blocked: boolean | undefined }[]>();
  for (const task of tasks) {
    const blocked = blockedTaskIds?.has(task.id);
    const status = nativeTaskStatus(task, blocked);
    const group = taskGroup(status);
    const rows = grouped.get(group) ?? [];
    rows.push({ task, status, blocked });
    grouped.set(group, rows);
  }

  return <div className={styles.groups}>
    {groups.map(([group, label]) => {
      const rows = grouped.get(group);
      if (!rows?.length) return null;
      return <section className={styles.group} aria-label={label} data-group={group} key={group}>
        <h2>{label}<span aria-label={`${rows.length} 项任务`}>{rows.length}</span></h2>
        <ul>
          {rows.map(({ task, status, blocked }) => {
            const Icon = Object.hasOwn(statusIcons, status) ? statusIcons[status as keyof typeof statusIcons] : CircleDot;
            const owner = task.agentTeamTask?.ownerName || task.agentTeamTask?.ownerId || "负责人未知";
            const hosts = new Set(task.targetNodeIds.map(id => nodeNames.get(id) ?? id));
            const assignment = [owner, ...(membershipNames.get(task.id) ?? []), ...hosts].filter(Boolean).join(" · ");
            const time = nativeTaskTime(task);
            const fact = group === "attention" ? nativeTaskFact(task, blocked) : undefined;
            const sourceTime = Number.isFinite(Date.parse(task.updatedAt)) ? task.updatedAt : undefined;
            return <li key={task.id}>
              <button className={styles.row} type="button" data-task-id={task.id} aria-current={selectedId === task.id ? "true" : undefined}
                ref={element => { if (element) rowRefs.set(task.id, element); else rowRefs.delete(task.id); }} onClick={() => onSelect(task.id)}>
                <span className={styles.titleLine}>
                  <span className={styles.title} title={task.goal}>{task.goal}</span>
                  <span className={styles.status} data-status={status}><Icon aria-hidden="true" size={13} strokeWidth={1.7} />{nativeTaskLabel(status)}</span>
                </span>
                {fact && <span className={styles.reason} title={fact}>{fact}</span>}
                <span className={styles.meta}>
                  <span className={styles.assignment} title={assignment}>{assignment}</span>
                  <time dateTime={sourceTime} title={sourceTime}>{time}</time>
                </span>
              </button>
            </li>;
          })}
        </ul>
      </section>;
    })}
  </div>;
}
