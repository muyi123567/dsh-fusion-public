import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentTeamRecord, NodeRecord, TaskRecord, SessionHubSnapshot } from "@dsh-fusion/core";
import { buildWhalePanelModel } from "../whale/model.js";
import { createSnapshotCoordinator } from "../../stream/snapshot-coordinator.js";
import { fusionBrowserUrl } from "../../routes.js";
import type { NativePanelData } from "./types.js";

interface Snapshot { nodes: NodeRecord[]; tasks: TaskRecord[]; agentTeams?: AgentTeamRecord[]; demo?: boolean; sessionHub?: SessionHubSnapshot; }
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
  model: buildWhalePanelModel({...snapshot, demo:snapshot.demo === true, loaded, stale:!!error}),
  tasks:snapshot.tasks, nodes:snapshot.nodes, teams:snapshot.agentTeams ?? [], loaded,
  ...(error ? {error} : {}),
 }), [snapshot, loaded, error]);
 return {data,refresh,refreshing, sourceWarning: loaded && !Array.isArray(snapshot.agentTeams) ? "团队来源未提供，归属未知" : undefined};
}
