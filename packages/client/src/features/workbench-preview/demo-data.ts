import type { AgentTeamRecord, NodeRecord, TaskEvidence, TaskRecord, TaskStatus } from "@dsh-fusion/core";
import { buildWhalePanelModel } from "../whale/model.js";

/** Fixed, synthetic design-comparison fixture. Never imported by a production entry. */
const AT = "2026-11-19T09:32:00.000Z";
const TEAM_ID = "demo-workbench-team";
const task = (number: number, goal: string, status: TaskStatus, owner: string, target: string, evidence: TaskEvidence[], extra: Partial<TaskRecord> = {}): TaskRecord => ({
  id: `demo-task-${number}`, goal, status, targetNodeIds: [target], transport: "ssh",
  evidence, createdAt: "2026-11-19T09:00:00.000Z", updatedAt: AT,
  agentTeamTask: {
    teamId: TEAM_ID, taskId: String(number), revision: 1,
    ownerId: `demo-owner-${owner}`, ownerName: owner, blockedBy: [],
    writeScopes: ["demo/workbench-preview"],
  },
  ...extra,
});

export const PREVIEW_TASKS: TaskRecord[] = [
  task(104, "复核原生面板交互", "verifying", "审查代理", "demo-reef", [
    { kind: "summary", label: "交互检查摘要", value: "合成演示证据 / E-104-01\n\n检查范围\n• 任务选择后在面板内显示详情\n• 状态筛选与名称搜索可以组合\n• 证据切换不离开当前任务\n• 聊天草稿在方案切换后保留\n\n此文本是前端演示内容，不是实际检查结果。\n任务仍处于 verifying，未独立验收。" },
    { kind: "artifact", label: "响应式检查收据", value: "合成演示证据 / E-104-02\n\n设计目标：1440 / 900 / 420 px\n窄屏设计：优先任务面板，隐藏宿主布局示意\n待核实：真实 DSH 右栏尺寸与宿主交互\n\n没有附带真实截图、产物或执行收据。" },
    { kind: "git", label: "变更范围说明", value: "合成演示证据 / E-104-03\n\n演示范围：独立 workbench-preview 页面\n不代表真实提交，不绑定任何生产版本。\n\n生产入口、宿主状态与执行接口不属于本演示。" },
  ]),
  task(105, "验证窄屏阅读顺序", "running", "界面代理", "demo-north", [
    { kind: "log", label: "布局检查记录", value: "合成演示记录 / E-105-01\n\n当前叙事情境：界面代理正在检查窄屏阅读顺序。\n页面不会执行检查，也不会自动推进任务状态。" },
  ]),
  task(102, "核对运行环境与配置", "failed", "环境代理", "demo-tide", [
    { kind: "summary", label: "配置差异说明", value: "合成演示证据 / E-102-01\n\n期望配置与演示节点配置不一致。\n需要人工确认来源后重新检查。\n\n未发起连接、修复、重试或真实执行。" },
  ], { error: "合成情境：配置版本不一致，当前结果不可作为后续执行依据。" }),
  task(106, "整理候选交付说明", "queued", "文档代理", "demo-reef", [], {
    dependsOnTaskIds: ["demo-task-104"],
    agentTeamTask: { teamId: TEAM_ID, taskId: "106", revision: 1, ownerName: "文档代理", ownerId: "demo-owner-docs", blockedBy: ["104"], writeScopes: ["demo/notes"], ready: false },
  }),
  task(103, "构建候选与类型检查", "completed", "构建代理", "demo-north", [
    { kind: "command", label: "构建命令示例", value: "合成演示证据 / E-103-01\n\n示例命令：pnpm --filter @dsh-fusion/client build\n\n此处仅显示文字，没有执行命令。\ncompleted 是合成任务状态，不是官方评测或独立验收结论。" },
    { kind: "artifact", label: "候选产物说明", value: "合成演示证据 / E-103-02\n\n产物名：demo-workbench-candidate\n没有真实下载地址、文件字节或 SHA-256。\n此项仅用于展示证据阅读体验。" },
  ]),
  task(101, "确认面板注册契约", "completed", "集成代理", "demo-reef", [
    { kind: "summary", label: "契约核对摘要", value: "合成演示证据 / E-101-01\n\n面板注册、标签与关闭动作交由宿主管理。\n这是设计演示文本，不是当前宿主的实测证明。" },
  ]),
];

export const PREVIEW_NODES: NodeRecord[] = [
  { id: "demo-north", externalId: "demo-north", providerId: "workbench-design-demo", name: "North · 构建", platform: "linux", roles: ["worker"], status: "online", configState: "current", transports: ["ssh"], capabilities: [] },
  { id: "demo-tide", externalId: "demo-tide", providerId: "workbench-design-demo", name: "Tide · 环境", platform: "linux", roles: ["worker"], status: "online", configState: "drift", transports: ["ssh"], capabilities: [] },
  { id: "demo-reef", externalId: "demo-reef", providerId: "workbench-design-demo", name: "Reef · 审查", platform: "linux", roles: ["worker"], status: "online", configState: "current", transports: ["ssh"], capabilities: [] },
];

export const PREVIEW_TEAM: AgentTeamRecord = {
  id: TEAM_ID, providerId: "workbench-design-demo", name: "远航团队", workspace: "demo/workbench",
  phase: "running", captainSessionId: "demo-captain", memberIds: ["demo-captain", ...PREVIEW_TASKS.flatMap(item => item.agentTeamTask?.ownerId ? [item.agentTeamTask.ownerId] : [])],
  taskIds: PREVIEW_TASKS.map(item => item.id),
};
export const PREVIEW_MODEL = buildWhalePanelModel({
  nodes: PREVIEW_NODES, tasks: PREVIEW_TASKS, agentTeams: [PREVIEW_TEAM], demo: true, loaded: true, stale: false,
});

export const TASK_NOTES: Record<string, { description: string; next: string; time: string }> = {
  "demo-task-104": { description: "检查任务、证据与宿主聊天之间的阅读路径，确认选择状态和草稿保留。", next: "由独立审查者核对交互与证据后，再决定是否验收。", time: "09:32" },
  "demo-task-105": { description: "检查窄屏布局是否先显示任务、再呈现详情，避免挤压聊天与产生额外遮罩。", next: "检查 900px 与 420px 的可读性和键盘焦点。", time: "09:28" },
  "demo-task-102": { description: "核对演示节点配置与候选环境，保留配置差异的明确解释。", next: "先确认配置来源与版本，不能把可达误认为可执行。", time: "09:24" },
  "demo-task-106": { description: "汇总候选边界、证据与未验证项，形成清晰的交付说明。", next: "等待“复核原生面板交互”完成独立验收。", time: "09:20" },
  "demo-task-103": { description: "演示一条回报完成的构建任务，以及它对应的命令与产物信息。", next: "任务回报 completed；是否通过验收仍需独立证据。", time: "09:18" },
  "demo-task-101": { description: "确认原生右栏的边界：宿主管理标签、宽度、关闭与聊天区。", next: "保持宿主控制权，继续检查真实原生环境。", time: "09:12" },
};
