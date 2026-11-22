import type { TaskEvidence, TaskRecord, TaskStatus } from "@dsh-fusion/core";

export type StudyScenario = "normal" | "long" | "unknown" | "stale" | "empty" | "unavailable" | "not-configured" | "missing";
export type StudyWidth = "420" | "560" | "wide";
export type StudyTheme = "light" | "dark";
export type TaskFilter = "all" | "attention" | "running" | "claimed" | "queued" | "completed" | "cancelled";

const AT = "2026-11-20T09:42:00.000+08:00";
const TEAM = "demo-voyage-team";
const makeTask = (
  number: number,
  goal: string,
  status: TaskStatus,
  owner: string,
  host: string,
  description: string,
  evidence: TaskEvidence[] = [],
  extra: Partial<TaskRecord> = {},
): TaskRecord => ({
  id: `demo-voyage-${number}`, goal, description, status,
  targetNodeIds: [host], transport: "ssh", evidence,
  createdAt: "2026-11-20T08:20:00.000+08:00", updatedAt: number === 104 ? AT : "2026-11-20T09:36:00.000+08:00",
  agentTeamTask: {
    teamId: TEAM, taskId: `TASK-${number}`, revision: 17,
    ownerId: `demo-owner-${number}`, ownerName: owner,
    blockedBy: [], writeScopes: ["demo/session-recovery"],
  },
  ...extra,
});

// This fixture is a local visual study, never imported by a production entry.
const TASKS: TaskRecord[] = [
  makeTask(104, "复核会话恢复补丁", "verifying", "林舟 · 审查", "Reef / 审查节点",
    "复核会话恢复时的任务保留规则，重点检查：较早的进行中任务，是否会被后续终态记录挤出恢复范围。\n\n对照变更说明与恢复日志，确认任务正文、负责人和上游修订仍能被完整读取。将发现的问题交还原任务处理；本任务不代替独立验收结论。",
    [
      { kind: "summary", label: "检查摘要", value: "待复核范围\n\n01  活跃任务与终态历史分别处理\n02  恢复后继续保留上游任务正文\n03  容量判断仍包含已恢复的活跃任务\n\n当前任务处于 verifying。以上是演示用审查提纲，并非已经执行的检查结果。" },
      { kind: "git", label: "变更说明", value: "变更范围\n\ndemo/session-recovery/ledger.ts\ndemo/session-recovery/ledger.test.ts\n\n拟议行为：非终态记录不使用终态历史配额。\n待核实：实现与回归检查是否覆盖重启恢复路径。\n\n此文本不绑定真实提交或补丁字节。" },
      { kind: "log", label: "恢复日志", value: "日志阅读示例\n\n[09:36] 开始读取恢复记录\n[09:36] 区分活跃任务与终态历史\n[09:37] 等待独立核对恢复后的任务集合\n\n以上为合成文本，不是本机运行输出；不能由此推断恢复成功。" },
    ], { expectedEvidence: ["summary", "git", "log"] }),
  makeTask(102, "核对跨会话的来源映射", "failed", "周屿 · 集成", "Tide / 集成节点",
    "核对任务来源序号与会话映射。保留失败事实，先定位同一来源中的修订差异，再决定是否进行后续检查。",
    [{ kind: "log", label: "差异记录", value: "映射检查记录\n\n来源序号与当前任务快照不一致。\n尚未确认差异的发生位置，未发起重试。\n\n这是一条用于阅读体验的合成失败记录。" }],
    { error: "来源序号未对齐，尚未重试。" }),
  makeTask(106, "补齐交付说明与证据索引", "queued", "许澄 · 文档", "Reef / 审查节点",
    "整理交付说明、变更范围与现有证据索引。等待前置复核完成后，再核对哪些结论可以进入交付说明。",
    [], {
      dependsOnTaskIds: ["demo-voyage-104"],
      agentTeamTask: {
        teamId: TEAM, taskId: "TASK-106", revision: 8,
        ownerId: "demo-owner-106", ownerName: "许澄 · 文档",
        blockedBy: ["TASK-104"], ready: false, writeScopes: ["demo/release-notes"],
      },
    }),
  makeTask(105, "检查窄栏的证据阅读路径", "running", "陈汐 · 界面", "North / 界面节点",
    "检查 420px 与 560px 面板中的列表、详情和证据阅读顺序。确认键盘返回恢复原任务焦点，且宿主聊天草稿保留。",
    [{ kind: "summary", label: "阅读检查提纲", value: "检查提纲\n\n选择任务 → 阅读当前事实 → 打开证据 → 返回任务列表。\n\n本任务显示为进行中，页面不会执行检查或推进任务状态。" }]),
  makeTask(108, "整理上游接口变更清单", "running", "林舟 · 集成", "Tide / 集成节点",
    "对照当前上游接口，整理任务投影字段与缺失情况。未提供的字段保持未知，不用默认值补成事实。"),
  makeTask(109, "补充来源陈旧的提示", "queued", "陈汐 · 界面", "North / 界面节点",
    "区分来源失败、保留的旧快照与合法空任务集合。来源陈旧时继续保留原始状态，不把旧记录解释为当前事实。"),
  makeTask(103, "保留任务正文与上游修订", "completed", "周屿 · 集成", "North / 界面节点",
    "任务记录回报 completed。继续保留正文与修订，供后续独立核对；完成状态本身不构成验收结论。",
    [{ kind: "artifact", label: "字段对照", value: "字段对照示例\n\n任务正文 → description\n上游修订 → agentTeamTask.revision\n负责人 → ownerName / ownerId\n\n此为合成资料，不是已生成的真实产物。" }]),
];

export function studyTasks(scenario: StudyScenario): TaskRecord[] {
  if (["empty", "not-configured"].includes(scenario)) return [];
  return TASKS.filter((_, index) => scenario !== "missing" || index !== 0).map((task, index) => {
    if (scenario === "stale" || scenario === "unavailable") return { ...task, updatedAt: "2026-11-20T09:15:00.000+08:00" };
    if (index !== 0) return task;
    if (scenario === "long") return {
      ...task,
      goal: "复核跨会话重启恢复补丁，确认较早的进行中任务与完整协作上下文不会因终态历史配额而丢失",
      agentTeamTask: { ...task.agentTeamTask!, taskId: "TASK-104-SESSION-RECOVERY-REVISION-17" },
    };
    if (scenario === "unknown") {
      const { ownerName: _name, ownerId: _id, ...projection } = task.agentTeamTask!;
      return { ...task, agentTeamTask: projection };
    }
    return task;
  });
}

export function taskState(task: TaskRecord): { key: string; label: string; reason: string } {
  if (task.status === "failed") return { key: "failed", label: "失败", reason: task.error ?? "来源回报失败，原因未提供。" };
  if (task.status === "completed") return { key: "completed", label: "已回报完成", reason: "来源回报完成，仍以证据为准。" };
  if (task.status === "cancelled") return { key: "cancelled", label: "已取消", reason: "来源回报任务已取消。" };
  if (task.agentTeamTask?.blockedBy.length) return { key: "blocked", label: "受阻", reason: `等待依赖 ${task.agentTeamTask.blockedBy.join("、")}。` };
  if (task.agentTeamTask?.ready === false) return { key: "blocked", label: "受阻", reason: "上游声明尚未就绪，原因未提供。" };
  if (task.status === "verifying") return { key: "verifying", label: "待验收", reason: "独立审查结论未提供。" };
  if (task.status === "claimed") return { key: "claimed", label: "已认领", reason: "来源状态为已认领。" };
  if (task.status === "running") return { key: "running", label: "进行中", reason: "来源状态为进行中。" };
  return { key: "queued", label: "稍后", reason: "来源状态为排队。" };
}

export function taskFact(task: TaskRecord): { primary: string; secondary: string } {
  const state = taskState(task);
  return {
    primary: state.key === "verifying" ? "独立审查结论未提供" : state.reason,
    secondary: task.evidence.length ? `${task.evidence.length} 项来源证据可阅读` : "来源未提供证据记录",
  };
}

export function taskTime(task: TaskRecord): string {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isFinite(timestamp) ? new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(timestamp) : "时间未提供";
}

export function sourceLabel(scenario: StudyScenario, detail = false): string {
  if (scenario === "stale") return detail ? "演示 · 全局 · 陈旧 09:15" : "来源陈旧";
  if (scenario === "unavailable") return detail ? "演示 · 全局 · 来源不可用" : "来源不可用";
  if (scenario === "not-configured") return detail ? "演示 · 全局 · 未配置" : "未配置";
  return detail ? "全局 · 演示来源" : "演示来源";
}

export function matchesFilter(task: TaskRecord, filter: TaskFilter): boolean {
  const key = taskState(task).key;
  if (filter === "attention") return ["failed", "blocked", "verifying"].includes(key);
  return filter === "all" || key === filter;
}

export const TASK_GROUPS = [
  { id: "attention", label: "需关注", keys: ["verifying", "failed", "blocked"] },
  { id: "running", label: "进行中", keys: ["running"] },
  { id: "claimed", label: "已认领", keys: ["claimed"] },
  { id: "queued", label: "稍后", keys: ["queued"] },
  { id: "completed", label: "已回报完成", keys: ["completed"] },
  { id: "cancelled", label: "已取消", keys: ["cancelled"] },
] as const;
