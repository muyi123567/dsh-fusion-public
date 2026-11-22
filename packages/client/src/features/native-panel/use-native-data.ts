import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTeamRecord, NodeRecord, TaskRecord, SessionHubSnapshot } from "@dsh-fusion/core";
import { buildWhalePanelModel } from "../whale/model.js";
import { createSnapshotCoordinator } from "../../stream/snapshot-coordinator.js";
import { fusionBrowserUrl } from "../../routes.js";
import type { NativeEnvironmentView, NativePanelData } from "./types.js";

type SourceKey = "nodes" | "tasks" | "agentTeams";
interface Snapshot {
 nodes: NodeRecord[]; tasks: TaskRecord[]; agentTeams?: AgentTeamRecord[]; demo?: boolean; sessionHub?: SessionHubSnapshot;
 sources?: Partial<Record<SourceKey, "live" | "demo" | "unavailable">>;
 providers?: Record<string, {state?: string}>;
 fleet?: {stale?: boolean};
 environment?: NativeEnvironmentView;
}

function collectionNotice(snapshot: Snapshot, key: SourceKey): string | undefined {
 const label = {nodes:"主机", tasks:"任务", agentTeams:"团队"}[key];
 const source = snapshot.sources?.[key];
 if (source === "demo" || (snapshot.demo === true && snapshot.sources === undefined)) return undefined;
 if (key === "agentTeams" && !Array.isArray(snapshot.agentTeams)) return "团队来源未提供，归属未知";
 // Tasks aggregate independent providers: a node/bridge failure must not mark
 // a separately live task collection as unavailable.
 const provider = key === "tasks" ? undefined : snapshot.providers?.[key];
 if (provider?.state === "not-configured") return label + "来源未配置";
 if (source === "unavailable" || provider?.state === "offline") return label + "来源不可用";
 if (key === "nodes" && snapshot.fleet?.stale) return label + "来源已陈旧";
 if (source === undefined) return label + "来源状态未提供";
 return undefined;
}
export function useNativeData(snapshotUrl: string, visible: boolean) {
 const [snapshot, setSnapshot] = useState<Snapshot>({nodes:[], tasks:[], agentTeams:[]});
 const [loaded, setLoaded] = useState(false);
 const [error, setError] = useState<string>();
 const [refreshing, setRefreshing] = useState(false);
 const reader = useRef<ReturnType<typeof createSnapshotCoordinator<Snapshot>>>();
 const refresh = useCallback(() => { void reader.current?.refresh().catch(() => {}); }, []);
 useEffect(() => {
  setSnapshot({nodes:[],tasks:[],agentTeams:[]}); setLoaded(false); setError(undefined);
 }, [snapshotUrl]);
 useEffect(() => {
  if (!visible) return;
  let active = true;
  const coordinator = createSnapshotCoordinator<Snapshot>({
   load: async signal => {
    setRefreshing(true);
    const response = await fetch(fusionBrowserUrl(snapshotUrl), {signal});
    if (!response.ok) throw new Error("快照读取失败（" + response.status + "）");
    const value = await response.json() as Snapshot;
    if (!Array.isArray(value.nodes) || !Array.isArray(value.tasks)) throw new Error("快照数据格式不完整");
    return value;
   },
   onSnapshot: value => { if (active) { setSnapshot(value); setLoaded(true); setError(undefined); setRefreshing(false); } },
   onError: () => { if (active) { setError("无法读取来源"); setRefreshing(false); } },
  });
  reader.current = coordinator;
  refresh();
  const timer = setInterval(() => { void coordinator.refreshCoalesced().catch(() => {}); }, 15000);
  return () => { active=false; clearInterval(timer); reader.current=undefined; coordinator.dispose(); setRefreshing(false); };
 }, [snapshotUrl, visible, refresh]);
 const data = useMemo<NativePanelData>(() => ({
  model: buildWhalePanelModel({...snapshot, demo:snapshot.demo === true, loaded, stale:!!error || (["nodes","tasks","agentTeams"] as const).some(key=>(snapshot[key]?.length ?? 0)>0 && collectionNotice(snapshot,key)!==undefined)}),
  tasks:snapshot.tasks, nodes:snapshot.nodes, teams:snapshot.agentTeams ?? [], loaded,
  ...(snapshot.environment === undefined ? {} : {environment:snapshot.environment}),
  ...(error ? {error} : {}),
 }), [snapshot, loaded, error]);
 return {data,refresh,refreshing,
  sourceNotices: {
   task: loaded ? collectionNotice(snapshot,"tasks") : undefined,
   host: loaded ? collectionNotice(snapshot,"nodes") : undefined,
   team: loaded ? collectionNotice(snapshot,"agentTeams") : undefined,
  },
  sourceWarning: loaded && !Array.isArray(snapshot.agentTeams) && !(snapshot.demo === true && snapshot.sources === undefined) ? "团队来源未提供，归属未知" : undefined,
 };
}
