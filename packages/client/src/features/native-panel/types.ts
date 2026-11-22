import type { ReactNode } from "react";
import type { AgentTeamRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import type { WhalePanelModel } from "../whale/types.js";
export interface NativePanelData {
 model:WhalePanelModel; tasks:TaskRecord[]; nodes:NodeRecord[]; teams:AgentTeamRecord[];
 environment?:NativeEnvironmentView;
 error?:string; loaded:boolean;
}
export interface NativeEnvironmentItem {
 code:string; severity:"block"|"warn"|"info"; path:string;
 expected?:unknown; actual?:unknown; remedy?:string;
}
export interface NativeEnvironmentView {
 hostId:string; displayName:string; observedAt:string; digest:string;
 expectedDigest?:string; overall:"match"|"drift"|"unknown"; reason?:string;
 stale:boolean; signed:boolean; items:NativeEnvironmentItem[];
}
export interface NativePanelSelection { kind:"task"|"host"|"team"; id:string; }
export interface NativePanelDetailsProps {
 backLabel?: string;
 selection: NativePanelSelection;
 data: NativePanelData;
 onBack: () => void;
 onSelect: (selection: NativePanelSelection) => void;
 source?: string;
 sourceWarning?: boolean;
 refreshControl?: ReactNode;
}
export interface NativeWhalePanelProps {snapshotUrl?:string;sessionId?:string;visible?:boolean;}
