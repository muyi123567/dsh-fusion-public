import { useRef, useState } from "react";
import type { TaskRecord } from "@dsh-fusion/core";
import { ArrowDown, ArrowLeft } from "lucide-react";
import type { NativePanelData, NativePanelDetailsProps, NativePanelSelection } from "./types.js";
import { WHALE_STATUS_TEXT } from "../whale/types.js";
import { NativeTaskContext } from "./NativeTaskContext.js";
import { NativeTaskEvidence } from "./NativeTaskEvidence.js";
import { NativeTaskExecution } from "./NativeTaskExecution.js";
import { nativeTaskFact, nativeTaskLabel, nativeTaskTime } from "./native-task-status.js";
import styles from "./native-details.module.css";

export { safeEvidenceUrl } from "./NativeTaskEvidence.js";

const enumLabels: Record<string, string> = { online: "在线", offline: "离线", degraded: "降级", current: "一致", drift: "存在漂移", unknown: "未知", staged: "准备中", running: "运行中", archived: "已归档", dedicated: "独享", shared: "共享", ssh: "SSH", seekfleet: "Seekfleet", "dsh-fleet": "DSH Fleet", yobiru: "Yobiru", tincan: "Tincan" };
const enumLabel = (value: string) => enumLabels[value] ?? value;

function LinkedTasks({ ids, data, onSelect }: {
  ids: readonly string[]; data: NativePanelData; onSelect: (selection: NativePanelSelection) => void;
}) {
  return ids.length ? <ul>{[...new Set(ids)].map(id => <li key={id}>
    <button type="button" onClick={() => onSelect({ kind: "task", id })}>{data.tasks.find(task => task.id === id)?.goal ?? id}</button>
  </li>)}</ul> : <p className={styles.muted}>未提供</p>;
}

function TaskDetail({ task, data, onSelect, copy }: {
  task: TaskRecord; data: NativePanelData; onSelect: (selection: NativePanelSelection) => void; copy: () => void;
}) {
  const evidenceRef = useRef<HTMLElement>(null);
  const upstream = task.agentTeamTask;
  const projected = data.model?.krill.find(item => item.id === task.id);
  const owners = upstream?.ownerName || upstream?.ownerId;
  const teams = [...new Map(data.teams.map(team => [team.id, team])).values()].filter(team => team.taskIds.includes(task.id));
  const evidenceCount = task.evidence.length;
  const fact = nativeTaskFact(task, projected?.blocked);
  const dateTime = Number.isFinite(Date.parse(task.updatedAt)) ? task.updatedAt : undefined;

  return <>
    <header className={styles.taskHeader}>
      <div className={styles.topline}>
        <code title={task.id}>{task.id}</code>
        <button className={styles.copy} type="button" onClick={copy}>复制 ID</button>
        <span data-state={task.status}>来源状态：{task.status === "completed" ? nativeTaskLabel(task.status) : WHALE_STATUS_TEXT[task.status] ?? task.status}</span>
      </div>
      <h2 className={styles.taskTitle}>{task.goal}</h2>
      <div className={styles.fact}>
        <p>{fact}</p>
        <p className={styles.muted}>{evidenceCount > 0 ? `${evidenceCount} 项来源证据可阅读` : "来源未提供证据记录"}</p>
      </div>
      <div className={styles.action}>
        {evidenceCount > 0 && <button className={styles.read} type="button" onClick={() => {
          evidenceRef.current?.scrollIntoView?.({ block: "start", inline: "nearest" });
          evidenceRef.current?.focus({ preventScroll: true });
        }}>阅读证据 <span>{String(evidenceCount).padStart(2, "0")}</span><ArrowDown size={14} aria-hidden="true" /></button>}
        <span className={styles.muted}>记录更新 <time dateTime={dateTime} title={dateTime}>{nativeTaskTime(task)}</time></span>
      </div>
    </header>
    <dl className={styles.attribution}>
      <div><dt>负责人</dt><dd>{owners || "未提供"}</dd></div>
      <div><dt>目标主机</dt><dd>{task.targetNodeIds.length > 0 ? [...new Set(task.targetNodeIds)].map(id =>
        <button key={id} className={styles.textButton} type="button" onClick={() => onSelect({ kind: "host", id })}>{data.nodes.find(node => node.id === id)?.name ?? id}</button>) : "未提供"}</dd></div>
      <div><dt>上游修订</dt><dd>{upstream?.revision ?? "未提供"}</dd></div>
      {teams.length > 0 && <div className={styles.attributionTeam}><dt>所属团队</dt><dd>{teams.map(team =>
        <button key={team.id} className={styles.textButton} type="button" onClick={() => onSelect({ kind: "team", id: team.id })}>{team.name}</button>)}</dd></div>}
    </dl>
    <NativeTaskEvidence task={task} sectionRef={evidenceRef} demo={data.model?.demo === true} />
    <NativeTaskExecution task={task} data={data} />
    <NativeTaskContext task={task} />
    <section className={styles.related} aria-label="任务关系与执行元数据">
      <h3>任务关系与执行元数据</h3>
      <p>进度：{task.progress === undefined ? "未报告" : `${task.progress}%`} · 传输：{enumLabel(task.transport)}</p>
      {task.error && task.error !== fact && <pre>{task.error}</pre>}
      <h4>依赖任务</h4><LinkedTasks ids={task.dependsOnTaskIds ?? []} data={data} onSelect={onSelect} />
      <h4>子任务</h4><LinkedTasks ids={(task.childTaskRefs ?? []).map(item => item.id)} data={data} onSelect={onSelect} />
    </section>
  </>;
}

export function NativePanelDetails({ selection, data, onBack, onSelect, backLabel, source, sourceWarning, refreshControl }: NativePanelDetailsProps) {
  const [copied, setCopied] = useState("");
  const task = selection.kind === "task" ? data.tasks.find(item => item.id === selection.id) : undefined;
  const host = selection.kind === "host" ? data.nodes.find(item => item.id === selection.id) : undefined;
  const team = selection.kind === "team" ? data.teams.find(item => item.id === selection.id) : undefined;
  const label = { task: "任务", host: "主机", team: "团队" }[selection.kind];
  const missing = !task && !host && !team;
  const copyId = () => {
    const fail = () => setCopied("复制不可用，请手动选择 ID");
    if (navigator.clipboard) void navigator.clipboard.writeText(selection.id).then(() => setCopied("已复制"), fail);
    else fail();
  };
  return <section className={styles.details} aria-label={`${label}详情`} tabIndex={-1} onKeyDown={event => {
    const target = event.target;
    const editing = target instanceof Element && target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false']), [role='textbox']");
    if (event.key === "Escape" && !event.defaultPrevented && !event.nativeEvent.isComposing && event.keyCode !== 229 && !editing && event.currentTarget.contains(target as Node)) {
      event.preventDefault();
      event.stopPropagation();
      onBack();
    }
  }}>
    <header className={styles.navigation}>
      <button className={styles.back} type="button" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" />{backLabel ?? "返回列表"}</button>
      {source && <span className={styles.source} role="status" data-warning={sourceWarning || undefined}>{source}</span>}
      {refreshControl}
    </header>
    {copied && <p className={styles.clipboard} role="status">{copied}</p>}
    {task && <TaskDetail task={task} data={data} onSelect={onSelect} copy={copyId} />}
    {!task && <div className={styles.generic}>
      <h2>{label}详情</h2>
      <div className={styles.topline}><code>{selection.id}</code><button className={styles.copy} type="button" onClick={copyId}>复制 ID</button></div>
      {missing && <p role="alert">记录已移除或未返回（record missing），请返回列表。</p>}
      {host && <>
        <h3>{host.name}</h3>
        <p>状态：{enumLabel(host.status)} · 传输：{host.transports.map(enumLabel).join("、")} · 配置：{enumLabel(host.configState)}</p>
        <p>CPU：{host.cpuPercent === undefined ? "未报告" : `${host.cpuPercent}%`} · 内存：{host.memoryPercent === undefined ? "未报告" : `${host.memoryPercent}%`}</p>
        {host.transports.includes("ssh") && <p>SSH 在线仅表示可达，不代表 PTY 已连接或任务已完成。</p>}
        {host.unavailableReason && <pre>{host.unavailableReason}</pre>}
        <h3>连接 / 兼容 / 能力 / 权限</h3>
        <dl>
          <dt>连接</dt><dd>{enumLabel(host.status)}；PTY 状态未提供</dd>
          <dt>兼容</dt><dd>DSH {host.dshVersion ?? "版本未提供"}；兼容性未验证</dd>
          <dt>能力</dt><dd>{host.capabilities.join("、") || "未报告"}（声明不等于运行验证）</dd>
          <dt>权限</dt><dd>{host.hostAccess ? `共享策略：${enumLabel(host.hostAccess.sharingMode)}；Owner：${host.hostAccess.ownerId ?? "未提供"}；实际授权未验证` : "权限策略未提供，实际授权未知"}</dd>
        </dl>
        <h3>关联任务</h3><LinkedTasks ids={data.tasks.filter(item => item.targetNodeIds.includes(host.id)).map(item => item.id)} data={data} onSelect={onSelect} />
      </>}
      {team && <>
        <h3>{team.name}</h3><p>{enumLabel(team.phase)} · {team.workspace}</p>
        <h3>关联任务</h3><LinkedTasks ids={team.taskIds} data={data} onSelect={onSelect} />
      </>}
    </div>}
  </section>;
}
