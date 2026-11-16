import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CircleAlert } from "lucide-react";
import {
  FUSION_DEFAULT_MODEL_ROUTE,
  FUSION_DEFAULT_REASONING_EFFORT,
  FUSION_PLUGIN_VERSION,
} from "@dsh-fusion/core";
import type {
  AgentFlowRecord,
  AgentTeamRecord,
  BotRecord,
  ConfigSnapshot,
  ExecutionPreview,
  GroupRecord,
  NodeRecord,
  RoomRecord,
  SessionRecord,
  SessionHubSnapshot,
  TaskRecord,
} from "@dsh-fusion/core";
import { BotWorkspace } from "./features/bots/BotWorkspace.js";
import type { FusionProviderStatusMap } from "./features/bridges/bridge-sources-model.js";
import { FleetRadar } from "./features/fleet/FleetRadar.js";
import type { FleetObservability } from "./features/fleet/fleet-observability.js";
import { MissionControl } from "./features/mission-control/MissionControl.js";
import {
  sessionCompositeId,
  sessionHubUrlFromSnapshot,
} from "./features/mission-control/use-session-hub.js";
import { RunCenter, type RunViewState } from "./features/runs/RunCenter.js";
import { RoomWorkspace } from "./features/rooms/RoomWorkspace.js";
import { TerminalTabs } from "./features/terminal/TerminalTabs.js";
import {
  TaskWorkspace,
  defaultTaskViewState,
  type TaskViewState,
} from "./features/tasks/TaskWorkspace.js";
import { ConfigWorkspace } from "./features/config/ConfigWorkspace.js";
import { mergeNodes } from "./features/fleet/node-model.js";
import { SetupWorkspace } from "./features/setup/SetupWorkspace.js";
import { createSnapshotCoordinator } from "./stream/snapshot-coordinator.js";
import { useFusionStream } from "./stream/use-fusion-stream.js";
import { fusionBrowserUrl } from "./routes.js";
import { RightDrawer } from "./shell/RightDrawer.js";
import { Sidebar, type WorkspaceMode } from "./shell/Sidebar.js";
import { Topbar } from "./shell/Topbar.js";
import { WhalePanel } from "./features/whale/WhalePanel.js";
import { buildWhalePanelModel } from "./features/whale/model.js";
import { useMediaQuery } from "./shell/focus-utils.js";
import "./styles/tokens.css";
import "./styles/app.css";
import "./styles/design-refresh.css";
import "./styles/whale-theme.css";

const bots: BotRecord[] = [
  { id: "chief", providerId: "demo", name: "Chief", role: "Chief of Staff", model: FUSION_DEFAULT_MODEL_ROUTE, reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT, isMain: true, status: "idle", memoryCount: 12, usageTokens: 69000 },
  { id: "node-ops", providerId: "demo", name: "节点管家", role: "节点运维与资源管理", model: FUSION_DEFAULT_MODEL_ROUTE, reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT, isMain: false, status: "working", memoryCount: 8, usageTokens: 18400 },
  { id: "executor", providerId: "demo", name: "工法管家", role: "工程方法与自动化", model: FUSION_DEFAULT_MODEL_ROUTE, reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT, isMain: false, status: "idle", memoryCount: 6, usageTokens: 12100 },
  { id: "search", providerId: "demo", name: "搜索管家", role: "知识搜索与信息整理", model: FUSION_DEFAULT_MODEL_ROUTE, reasoningEffort: FUSION_DEFAULT_REASONING_EFFORT, isMain: false, status: "idle", memoryCount: 4, usageTokens: 9200 },
];

const groups: GroupRecord[] = [
  { id: "content-code", providerId: "demo", name: "内容与代码", adminBotId: "chief", memberBotIds: ["chief", "executor", "search"], unreadCount: 3 },
  { id: "ops", providerId: "demo", name: "运维值班", adminBotId: "node-ops", memberBotIds: ["chief", "node-ops"], unreadCount: 0 },
];

const nodes: NodeRecord[] = [
  { id: "windows-main", externalId: "windows-main", providerId: "demo", name: "Windows 控制机", platform: "windows", roles: ["control", "worker"], status: "online", transports: ["seekfleet", "ssh"], capabilities: ["windows", "powershell", "browser"], dshVersion: "0.2.0-rc.2", configHash: "4f7c2a", configState: "current", lastHeartbeat: "刚刚", cpuPercent: 12, memoryPercent: 36 },
  { id: "tencent", externalId: "tencent", providerId: "demo", name: "腾讯 Worker", platform: "linux", roles: ["worker"], status: "online", transports: ["seekfleet", "ssh"], capabilities: ["linux", "build", "pytest"], dshVersion: "0.2.0-rc.2", configHash: "4f7c2a", configState: "current", lastHeartbeat: "1 分钟前", cpuPercent: 48, memoryPercent: 62 },
  { id: "oracle", externalId: "oracle", providerId: "demo", name: "Oracle Worker", platform: "linux", roles: ["worker"], status: "online", transports: ["seekfleet", "ssh"], capabilities: ["linux", "gpu"], dshVersion: "0.2.0-rc.2", configHash: "91d0be", configState: "drift", lastHeartbeat: "2 分钟前", cpuPercent: 18, memoryPercent: 41 },
];

const sessions: SessionRecord[] = [
  { id: "session-chief", providerId: "demo", nodeId: "windows-main", botId: "chief", title: "Chief · 多机任务", status: "live", updatedAt: "刚刚" },
  { id: "session-tencent", providerId: "demo", nodeId: "tencent", botId: "executor", title: "腾讯 · 全量测试", status: "live", updatedAt: "1 分钟前" },
  { id: "session-oracle", providerId: "demo", nodeId: "oracle", botId: "node-ops", title: "Oracle · 配置检查", status: "idle", updatedAt: "2 分钟前" },
];

const tasks: TaskRecord[] = [
  { id: "T-demo-001", goal: "运行全量测试", requestedByBotId: "chief", targetNodeIds: ["windows-main", "tencent", "oracle"], transport: "seekfleet", status: "running", progress: 62, sessionId: "session-tencent", evidence: [{ kind: "log", label: "windows-test.log", value: "环境准备完成" }, { kind: "log", label: "tencent-test.log", value: "应用测试执行中" }], expectedEvidence: ["log", "artifact"], createdAt: "14:26", updatedAt: "14:29" },
  { id: "T-demo-002", goal: "配置一致性检查", requestedByBotId: "chief", targetNodeIds: ["tencent", "oracle"], transport: "seekfleet", status: "queued", progress: 0, evidence: [], createdAt: "14:30", updatedAt: "14:30" },
];

const WORKSPACE_MODE_LABELS: Record<WorkspaceMode, string> = {
  ocean: "鲸群总览",
  setup: "开箱检查",
  bot: "对话",
  fleet: "节点",
  tasks: "多机任务",
  sessions: "Mission Control",
  rooms: "会话房间",
  runs: "Run Center",
  terminal: "终端",
  config: "配置",
};

const unconfiguredBot: BotRecord = {
  id: "unconfigured",
  providerId: "none",
  name: "DS Bot 未配置",
  role: "等待 Bot provider 健康检查",
  model: "not-configured",
  isMain: true,
  status: "offline",
};

const unconfiguredNode: NodeRecord = {
  id: "unconfigured",
  externalId: "unconfigured",
  providerId: "none",
  name: "节点未配置",
  platform: "unknown",
  roles: ["worker"],
  status: "offline",
  transports: [],
  capabilities: [],
  configState: "unknown",
};

const initialConfig: ConfigSnapshot = {
  revision: "unobserved",
  hash: "sha256:unobserved",
  pluginVersions: {
    "dsh-fusion": FUSION_PLUGIN_VERSION,
  },
  nodeStates: {},
};

interface FusionSnapshotPayload {
  demo: boolean;
  bots: BotRecord[];
  groups: GroupRecord[];
  nodes: NodeRecord[];
  sessions: SessionRecord[];
  tasks: TaskRecord[];
  agentTeams?: AgentTeamRecord[];
  agentFlows?: AgentFlowRecord[];
  rooms?: RoomRecord[];
  providers?: FusionProviderStatusMap;
  config?: ConfigSnapshot;
  sessionHub?: SessionHubSnapshot;
  fleet?: FleetObservability;
}

export function FusionApp({
  initialMode = "bot",
  snapshotUrl = "/api/fusion/snapshot",
  roomCommand,
}: {
  initialMode?: WorkspaceMode;
  snapshotUrl?: string;
  roomCommand?: (input: string) => Promise<void>;
}) {
  const standaloneSnapshot = snapshotUrl.startsWith("/api/fusion/");
  const sessionHubUrl = sessionHubUrlFromSnapshot(snapshotUrl);
  const [mode, setMode] = useState<WorkspaceMode>(initialMode);
  const [botData, setBotData] = useState<BotRecord[]>(() => standaloneSnapshot ? bots : []);
  const [groupData, setGroupData] = useState<GroupRecord[]>(() => standaloneSnapshot ? groups : []);
  const [nodeData, setNodeData] = useState<NodeRecord[]>(() => standaloneSnapshot ? nodes : []);
  const [sessionData, setSessionData] = useState<SessionRecord[]>(() => standaloneSnapshot ? sessions : []);
  const [taskData, setTaskData] = useState<TaskRecord[]>(() => standaloneSnapshot ? tasks : []);
  const [agentTeamData, setAgentTeamData] = useState<AgentTeamRecord[]>();
  const [agentFlowData, setAgentFlowData] = useState<AgentFlowRecord[]>();
  const [roomData, setRoomData] = useState<RoomRecord[]>();
  const [configData, setConfigData] = useState<ConfigSnapshot>(initialConfig);
  const [providerStatuses, setProviderStatuses] = useState<FusionProviderStatusMap>({});
  const [allowDemo, setAllowDemo] = useState(standaloneSnapshot);
  const [snapshotLoaded, setSnapshotLoaded] = useState(standaloneSnapshot);
  const [snapshotError, setSnapshotError] = useState<string>();
  const [selectedBotId, setSelectedBotId] = useState("chief");
  const [selectedNodeId, setSelectedNodeId] = useState("tencent");
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  // Workspace-owned page state: survives the conditional
  // mounts below, so leaving a page and coming back restores
  // its filters, drafts and selections (review 03 item 1).
  const [taskViewState, setTaskViewState] = useState<TaskViewState>(defaultTaskViewState);
  const [runViewState, setRunViewState] = useState<RunViewState>({ tab: "running" });
  const [botDrafts, setBotDrafts] = useState<Record<string, string>>({});
  const [taskOrigin, setTaskOrigin] = useState<WorkspaceMode>();
  const [sessionHubSnapshot, setSessionHubSnapshot] = useState<SessionHubSnapshot>();
  const whaleModel = useMemo(() => buildWhalePanelModel({nodes:nodeData,tasks:taskData,...(sessionHubSnapshot===undefined?{}:{sessionHub:sessionHubSnapshot}),...(agentTeamData===undefined?{}:{agentTeams:agentTeamData}),demo:allowDemo,loaded:snapshotLoaded,stale:snapshotError!==undefined}),[nodeData,taskData,agentTeamData,allowDemo,snapshotLoaded,snapshotError,sessionHubSnapshot]);
  const whaleSourceWarnings = useMemo(() => {
    if (standaloneSnapshot) return [];
    const warnings: string[] = [];
    if (agentTeamData === undefined) warnings.push("团队任务来源尚未观测；零团队不代表已确认空板。");
    for (const [key,label] of [["agentTeams","团队"],["nodes","主机"]] as const) {
      const source=providerStatuses[key];
      if(source===undefined) { if(key==="nodes") warnings.push("主机来源状态尚未提供。"); continue; }
      if(source.state!=="connected") warnings.push(label+"来源"+(source.state==="offline"?"不可达":source.state==="not-configured"?"未配置":"降级")+"；请核对来源与权限。");
    }
    return warnings;
  },[standaloneSnapshot,agentTeamData,providerStatuses]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileDrawerOpen(false);
      setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);
  const [fleetObservability, setFleetObservability] = useState<FleetObservability>();
  const coordinatorRef = useRef<ReturnType<typeof createSnapshotCoordinator<FusionSnapshotPayload>>>();
  const snapshotScope = useMemo(() => ({}), [snapshotUrl]);
  const scopeRef = useRef(snapshotScope);
  scopeRef.current = snapshotScope;
  const [selectedRoomId, setSelectedRoomId] = useState<string>();
  const [requestedSession, setRequestedSession] = useState<{
    sourceId: string;
    nativeSessionId: string;
    token: number;
  }>();
  const [mainSessionId, setMainSessionId] = useState<string>();
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  // An open state is a modal overlay only inside its fixed
  // presentation range; above it the same regions are static
  // layout and the background stays interactive.
  const sidebarViewport = useMediaQuery("(max-width: 760px)");
  const drawerViewport = useMediaQuery("(max-width: 1120px)");
  const sidebarOverlay = mobileSidebarOpen && sidebarViewport;
  const drawerOverlay = mobileDrawerOpen && drawerViewport;
  const anyOverlay = sidebarOverlay || drawerOverlay;

  // Overlay state belongs to its breakpoint range. Above
  // 760px the sidebar is a static column and above 1120px
  // the drawer is permanently visible, so an open state
  // carried across the crossing would leave a fullscreen
  // scrim (rendered from the raw state) with no overlay
  // behind it. Crossing up closes the state with it.
  useEffect(() => {
    if (!sidebarViewport) setMobileSidebarOpen(false);
  }, [sidebarViewport]);
  useEffect(() => {
    if (!drawerViewport) setMobileDrawerOpen(false);
  }, [drawerViewport]);
  useEffect(() => {
    const shell = shellRef.current;
    if (shell === null) return;
    const setInert = (element: Element | null, on: boolean) => {
      if (element === null) return;
      const target = element as HTMLElement & { inert?: boolean };
      target.inert = on;
      if (on) target.setAttribute("inert", "");
      else target.removeAttribute("inert");
    };
    // While a modal overlay is up, the page behind it — the
    // main region and the sibling region that is not open —
    // is inert: unreachable by keyboard and assistive tech.
    setInert(shell.querySelector("main"), anyOverlay);
    setInert(shell.querySelector("#fusion-sidebar"), drawerOverlay && !sidebarOverlay);
    setInert(shell.querySelector("#fusion-right-drawer"), sidebarOverlay && !drawerOverlay);
    return () => {
      setInert(shell.querySelector("main"), false);
      setInert(shell.querySelector("#fusion-sidebar"), false);
      setInert(shell.querySelector("#fusion-right-drawer"), false);
    };
  }, [anyOverlay, sidebarOverlay, drawerOverlay]);
  const [refreshSignal, setRefreshSignal] = useState(0);

  const applySnapshot = useCallback((snapshot: FusionSnapshotPayload) => {
    setBotData(snapshot.bots);
    setGroupData(snapshot.groups);
    setNodeData(snapshot.nodes);
    setSessionData(snapshot.sessions);
    setTaskData(snapshot.tasks);
    setAgentTeamData(snapshot.agentTeams);
    setAgentFlowData(snapshot.agentFlows);
    setRoomData(snapshot.rooms);
    setSessionHubSnapshot(snapshot.sessionHub);
    // The fleet block exists only on fleet-configured payloads;
    // assigning it unconditionally also clears the radar strip
    // when a later payload stops carrying it.
    setFleetObservability(snapshot.fleet);
    setProviderStatuses(snapshot.providers ?? {});
    if (snapshot.config !== undefined) setConfigData(snapshot.config);
    setAllowDemo(snapshot.demo === true);
    setSnapshotLoaded(true);
  }, []);

  const refresh = useCallback(async () => {
    const coordinator = coordinatorRef.current;
    if (scopeRef.current !== snapshotScope || coordinator === undefined) {
      throw new DOMException("Workspace changed", "AbortError");
    }
    await coordinator.refresh();
  }, [snapshotScope]);

  // Ordinary stream events go through the merge window so an event
  // burst costs at most one snapshot load per window; a gap forces
  // the immediate authoritative refresh instead.
  const refreshFromStream = useCallback(() => {
    const coordinator = coordinatorRef.current;
    if (scopeRef.current !== snapshotScope || coordinator === undefined) return;
    void coordinator.refreshCoalesced().catch(() => {});
  }, [snapshotScope]);

  const streamState = useFusionStream({
    snapshotUrl,
    onChange: refreshFromStream,
    onGap: () => { void refresh().catch(() => {}); },
    enabled: import.meta.env.MODE !== "test",
  });

  useEffect(() => {
    let firstLoad = true;
    setSnapshotLoaded(standaloneSnapshot);
    const coordinator = createSnapshotCoordinator<FusionSnapshotPayload>({
      coalesceMs: 250,
      load: async (signal) => {
        const response = await fetch(fusionBrowserUrl(snapshotUrl), { signal });
        if (!response.ok) throw new Error(`snapshot ${response.status}`);
        return await response.json() as FusionSnapshotPayload;
      },
      onSnapshot: (snapshot) => {
        applySnapshot(snapshot);
        setSnapshotError(undefined);
        setRefreshSignal((current) => current + 1);
        firstLoad = false;
      },
      onError: (error) => {
        setSnapshotError(error instanceof Error ? error.message : String(error));
        setProviderStatuses({
          nodes: { state: "offline", checkedAt: Date.now(), message: "snapshot refresh failed" },
          agentTeams: { state: "offline", checkedAt: Date.now(), message: "snapshot refresh failed" },
          agentBus: { state: "offline", checkedAt: Date.now(), message: "snapshot refresh failed" },
          room: { state: "offline", checkedAt: Date.now(), message: "snapshot refresh failed" },
          huawei: { state: "offline", checkedAt: Date.now(), message: "snapshot refresh failed" },
        });
        // Observation failure is not entity state: the
        // failure lives in the provider statuses, the error
        // banner and snapshot staleness (which blocks write
        // actions). Last-known node statuses and session
        // execution state are preserved as-is — unobservable
        // must not be presented as proven offline/stopped.
        // Only capability facts fail closed: hub sessions
        // lose agent availability until a read succeeds.
        setSessionHubSnapshot((current) => current === undefined ? current : {
          ...current,
          provider: "failed",
          sessions: current.sessions.map((session) => ({
            ...session,
            agentAvailable: false,
            lastError: "snapshot refresh failed",
          })),
          sources: current.sources.map((source) => ({ ...source, state: "failed", error: "snapshot refresh failed" })),
        });
        if (!firstLoad) return;
        setSnapshotLoaded(false);
        setBotData([]);
        setGroupData([]);
        setSessionData([]);
        setTaskData([]);
        setAgentTeamData(undefined);
        setAgentFlowData(undefined);
        setRoomData(undefined);
        setConfigData(initialConfig);
        setAllowDemo(standaloneSnapshot);
      },
    });
    coordinatorRef.current = coordinator;
    // Existing isolated component tests intentionally use local demo fixtures.
    const timer = import.meta.env.MODE === "test" ? undefined : window.setInterval(() => {
      void coordinator.refresh().catch(() => {});
    }, 15_000);
    if (import.meta.env.MODE !== "test") void coordinator.refresh().catch(() => {});
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      coordinator.dispose();
      if (coordinatorRef.current === coordinator) coordinatorRef.current = undefined;
    };
  }, [snapshotUrl, standaloneSnapshot, applySnapshot]);

  const openTask = (taskId: string) => {
    // Remember where the jump came from so the tasks page can
    // offer the way back; jumps within the tasks page itself
    // keep any earlier origin.
    if (mode !== "tasks") setTaskOrigin(mode);
    setSelectedTaskId(taskId);
    setMode("tasks");
    setMobileSidebarOpen(false);
  };
  const checkFleet = snapshotUrl.startsWith("/plugins/dsh-fusion/") ? async () => {
    const response = await fetch(fusionBrowserUrl("/plugins/dsh-fusion/doctor"));
    const body = await response.json().catch(() => ({})) as { error?: string; message?: string; status?: string };
    await refresh();
    if (!response.ok || body.status !== "ok") {
      throw new Error(
        body.error
        ?? body.message
        ?? `fleet doctor ${body.status ?? response.status}`,
      );
    }
  } : undefined;

  const mergedNodes = useMemo(() => mergeNodes(nodeData), [nodeData]);
  const pluginMode = snapshotUrl.startsWith("/plugins/dsh-fusion/");
  const needsSetup = snapshotLoaded && (botData.length === 0 || mergedNodes.length === 0);
  const selectedBot = botData.find((bot) => bot.id === selectedBotId) ?? botData[0] ?? unconfiguredBot;
  const selectedBotSession = sessionData.find((session) => session.botId === selectedBot.id);
  const selectedNode = mergedNodes.find((node) => node.id === selectedNodeId) ?? mergedNodes[0] ?? unconfiguredNode;
  const selectedBotTasks = useMemo(
    () => taskData.filter((task) =>
      task.requestedByBotId === selectedBot.id || task.sessionId === selectedBot.id
    ).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)),
    [selectedBot.id, taskData],
  );
  const previewTask = useCallback(async (nodeIds: string[]): Promise<ExecutionPreview> => {
    const actionCoordinator = coordinatorRef.current;
    if (scopeRef.current !== snapshotScope || actionCoordinator === undefined) {
      throw new DOMException("Workspace changed", "AbortError");
    }
    const response = await fetch(fusionBrowserUrl("/plugins/dsh-fusion/tasks/preview"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeIds }),
    });
    const payload = await response.json().catch(() => ({})) as ExecutionPreview & { error?: string };
    if (scopeRef.current !== snapshotScope || coordinatorRef.current !== actionCoordinator) {
      throw new DOMException("Workspace changed", "AbortError");
    }
    if (!response.ok) throw new Error(payload.error ?? `执行条件检查失败 (HTTP ${response.status})`);
    return payload;
  }, [snapshotScope]);
  const previewSourceKey = JSON.stringify(Object.entries(providerStatuses).sort(([left], [right]) => left.localeCompare(right))
    .map(([id, status]) => {
      // Ordinary polling advances checkedAt without changing source health or identity.
      const { checkedAt: _checkedAt, ...source } = status;
      return [id, source];
    }));
  const dispatchTask = async (input: {
    goal: string;
    command: string;
    nodeIds: string[];
    idempotencyKey?: string | undefined;
  }) => {
    const actionCoordinator = coordinatorRef.current;
    const pluginRoute = snapshotUrl.startsWith("/plugins/dsh-fusion/");
    const endpoint = pluginRoute ? "/plugins/dsh-fusion/tasks" : "/api/fusion/tasks";
    const response = await fetch(fusionBrowserUrl(endpoint), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.idempotencyKey === undefined ? {} : { "idempotency-key": input.idempotencyKey }),
      },
      body: JSON.stringify(pluginRoute
        ? { goal: input.goal, command: input.command, nodeIds: input.nodeIds }
        : { goal: input.goal, nodeIds: input.nodeIds }),
    });
    const payload = await response.json().catch(() => ({})) as TaskRecord & { error?: string };
    if (scopeRef.current !== snapshotScope || coordinatorRef.current !== actionCoordinator) {
      throw new DOMException("Workspace changed", "AbortError");
    }
    if (typeof payload.id === "string") {
      setTaskData((current) => [payload, ...current.filter((task) => task.id !== payload.id)]);
    }
    if (!response.ok) {
      throw new Error(payload.error ?? `任务派发失败 (${response.status})`);
    }
    await refresh();
    return payload;
  };
  const cancelTask = async (taskId: string) => {
    const actionCoordinator = coordinatorRef.current;
    const pluginRoute = snapshotUrl.startsWith("/plugins/dsh-fusion/");
    const endpoint = pluginRoute
      ? "/plugins/dsh-fusion/tasks/cancel"
      : `/api/fusion/tasks/${encodeURIComponent(taskId)}/cancel`;
    const response = await fetch(fusionBrowserUrl(endpoint), {
      method: "POST",
      ...(pluginRoute
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ taskId }),
          }
        : {}),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      throw new Error(body.error ?? `取消任务失败 (${response.status})`);
    }
    if (scopeRef.current !== snapshotScope || coordinatorRef.current !== actionCoordinator) {
      throw new DOMException("Workspace changed", "AbortError");
    }
    setTaskData((current) => current.map((task) => (
      task.id === taskId ? { ...task, status: "cancelled", progress: 0 } : task
    )));
    await refresh();
  };

  return (
    <div ref={shellRef} className={"fusion-shell" + (mode === "setup" ? " is-setup" : "") + (mode === "tasks" ? " is-tasks" : "") + (mode === "ocean" ? " is-ocean" : "")}>
      <Sidebar
        mode={mode}
        onModeChange={(nextMode) => {
          setTaskOrigin(undefined);
          setMode(nextMode);
          setMobileSidebarOpen(false);
          setMobileDrawerOpen(false);
        }}
        bots={botData.length === 0 ? [unconfiguredBot] : botData}
        groups={groupData}
        nodes={mergedNodes}
        sessions={sessionData}
        selectedBotId={selectedBot.id}
        {...(requestedSession === undefined ? {} : {
          selectedSessionId: sessionCompositeId(
            requestedSession.sourceId,
            requestedSession.nativeSessionId,
          ),
        })}
        onSelectBot={(bot) => {
          setTaskOrigin(undefined);
          setSelectedBotId(bot.id);
          setMode("bot");
          setMobileSidebarOpen(false);
        }}
        onSelectNode={(node) => {
          setTaskOrigin(undefined);
          setSelectedNodeId(node.id);
          setMode("fleet");
          setMobileSidebarOpen(false);
        }}
        onSelectSession={(session) => {
          setRequestedSession({
            sourceId: session.providerId,
            nativeSessionId: session.id,
            token: Date.now(),
          });
          setTaskOrigin(undefined);
          setMode("sessions");
          setMobileSidebarOpen(false);
        }}
        onSelectRoom={(roomId) => {
          setTaskOrigin(undefined);
          setSelectedRoomId(roomId);
          setMode("rooms");
          setMobileSidebarOpen(false);
        }}
        mobileOpen={mobileSidebarOpen}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {(mobileSidebarOpen || mobileDrawerOpen) && (
        <button
          type="button"
          className="fusion-mobile-scrim"
          aria-label="关闭浮层"
          tabIndex={anyOverlay ? -1 : undefined}
          onClick={() => {
            setMobileSidebarOpen(false);
            setMobileDrawerOpen(false);
          }}
        />
      )}
      <main className="fusion-main">
        <Topbar
          mode={mode}
          selectedBot={selectedBot}
          selectedNode={selectedNode}
          onToggleSidebar={() => setMobileSidebarOpen((current) => !current)}
          onToggleDetails={() => setMobileDrawerOpen((current) => !current)}
          detailsOpen={mobileDrawerOpen}
          onOpenConfig={() => {
            setMode("config");
            setMobileDrawerOpen(false);
            setMobileSidebarOpen(false);
          }}
          streamStatus={streamState.status}
          streamRefusal={streamState.refusal}
          streamGap={streamState.gap}
        />
        {snapshotError === undefined ? null : (
          <p className="fusion-snapshot-warning" role="status">
            实时状态刷新失败，保留的上次数据已标记为不可用：{snapshotError}
          </p>
        )}
        {streamState.refusal === undefined ? null : (
          <p className="fusion-snapshot-warning" role="status">
            {streamState.refusal}，已回退到定时轮询
          </p>
        )}
        {streamState.gap === undefined ? null : (
          <p className="fusion-snapshot-warning" role="status">
            事件流缺口（{streamState.gap.reason === "buffer-overflow" ? "缓冲区溢出" : "序列重置"}）：
            缺失 seq {streamState.gap.missingFrom}-{streamState.gap.missingTo}，已请求全量快照拉取。
          </p>
        )}
        {mode === "bot" && needsSetup ? (
          <button
            type="button"
            className="fusion-setup-inline"
            aria-label="打开开箱检查"
            onClick={() => setMode("setup")}
          >
            <CircleAlert size={16} aria-hidden="true" />
            <span>
              <strong>完成鲸插件开箱检查</strong>
              <small>当前缺少 Bot 或执行节点，先确认版本、连接和权限。</small>
            </span>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        ) : null}
        {mode === "ocean" && <WhalePanel model={whaleModel} sourceWarnings={whaleSourceWarnings}
          onOpenTask={openTask}
          onOpenHost={(id)=>{setSelectedNodeId(id);setMode("fleet");}}
          onNavigate={(destination)=>{setMode(destination);setMobileSidebarOpen(false);setMobileDrawerOpen(false);}}
        />}
        {mode === "setup" && (
          <SetupWorkspace
            snapshotLoaded={snapshotLoaded}
            pluginMode={pluginMode}
            allowDemo={allowDemo}
            nodes={mergedNodes}
            providers={providerStatuses}
            config={configData}
            {...(snapshotError === undefined ? {} : { snapshotError })}
            {...(checkFleet === undefined ? {} : { onCheck: checkFleet })}
            onOpenConfig={() => setMode("config")}
            onOpenFleet={() => setMode("fleet")}
            onOpenTasks={() => setMode("tasks")}
          />
        )}
        {mode === "bot" && (
          <BotWorkspace
            bot={selectedBot}
            onOpenTask={openTask}
            tasks={selectedBotTasks}
            nodes={mergedNodes}
            connectionStale={snapshotError !== undefined}
            draft={botDrafts[selectedBot.id] ?? ""}
            onDraftChange={(draft) => setBotDrafts((current) => ({ ...current, [selectedBot.id]: draft }))}
            {...(selectedBotSession === undefined ? {} : { session: selectedBotSession })}
            {...(sessionHubUrl === undefined ? {} : { sessionHubUrl })}
          />
        )}
        {mode === "fleet" && (
          <FleetRadar
            nodes={mergedNodes}
            selectedNodeId={selectedNode.id}
            onSelectNode={setSelectedNodeId}
            onOpenSetup={() => setMode("setup")}
            {...(checkFleet === undefined ? {} : { onCheck: checkFleet })}
            {...(fleetObservability === undefined ? {} : { fleet: fleetObservability })}
          />
        )}
        {mode === "tasks" && taskOrigin !== undefined && taskOrigin !== "tasks" && (
          <button
            type="button"
            className="fusion-return-button"
            onClick={() => {
              const origin = taskOrigin;
              setTaskOrigin(undefined);
              setMode(origin);
            }}
          >
            ← 返回 {WORKSPACE_MODE_LABELS[taskOrigin]}
          </button>
        )}
        {mode === "tasks" && (
          <TaskWorkspace
            tasks={taskData}
            nodes={mergedNodes}
            connectionStale={snapshotError !== undefined}
            allowExtensionActions={false}
            viewState={taskViewState}
            onViewStateChange={setTaskViewState}
            {...(selectedTaskId === undefined ? {} : { selectedTaskId })}
            onSelectTask={setSelectedTaskId}
            onCloseTask={() => setSelectedTaskId(undefined)}
            onDispatch={dispatchTask}
            {...(pluginMode ? { onPreview: previewTask, previewSourceKey } : {})}
            onCancel={cancelTask}
          />
        )}
        {mode === "sessions" && (
          <MissionControl
            sessions={sessionData}
            {...(sessionHubSnapshot === undefined && standaloneSnapshot ? {} : {
              sessionHubSnapshot: sessionHubSnapshot ?? { provider: "unavailable" as const, sessions: [], sources: [], checkedAt: 0 },
            })}
            nodes={mergedNodes}
            {...(sessionHubUrl === undefined ? {} : { sessionHubUrl })}
            refreshSignal={refreshSignal}
            {...(requestedSession === undefined ? {} : {
              requestedSessionSourceId: requestedSession.sourceId,
              requestedSessionId: requestedSession.nativeSessionId,
              requestToken: requestedSession.token,
            })}
            {...(mainSessionId === undefined ? {} : { mainSessionId })}
            onOpenMain={(sessionId) => setMainSessionId((current) => current === sessionId ? undefined : sessionId)}
          />
        )}
        {mode === "rooms" && (
          <RoomWorkspace
            rooms={roomData ?? []}
            {...(selectedRoomId === undefined ? {} : { selectedRoomId })}
            onSelectRoom={setSelectedRoomId}
            {...(roomCommand === undefined ? {} : { onCommand: roomCommand })}
          />
        )}
        {mode === "runs" && (
          <RunCenter
            {...(agentTeamData === undefined ? {} : { agentTeams: agentTeamData })}
            {...(agentFlowData === undefined ? {} : { agentFlows: agentFlowData })}
            {...(roomData === undefined ? {} : { rooms: roomData })}
            providers={providerStatuses}
            allowDemo={allowDemo}
            onOpenTask={openTask}
            tasks={taskData}
            viewState={runViewState}
            onViewStateChange={setRunViewState}
          />
        )}
        {mode === "terminal" && (
          <TerminalTabs
            remotePtyEnabled={snapshotUrl.startsWith("/plugins/dsh-fusion/")}
            servers={mergedNodes.map((node) => ({
              id: node.id,
              name: node.name,
              status: node.status === "online" ? "online" : "offline",
            }))}
          />
        )}
        {mode === "config" && (
          <ConfigWorkspace
            nodes={mergedNodes}
            snapshot={configData}
            onRefresh={refresh}
            pluginMode={snapshotUrl.startsWith("/plugins/dsh-fusion/")}
          />
        )}
      </main>
      {mode === "ocean" || mode === "setup" || mode === "tasks" ? null : (
        <RightDrawer
          mode={mode}
          bot={selectedBot}
          node={selectedNode}
          tasks={taskData}
          mobileOpen={mobileDrawerOpen}
          onCloseMobile={() => setMobileDrawerOpen(false)}
        />
      )}
    </div>
  );
}
