import type { AgentTeamRecord, NodeRecord, TaskRecord } from "@dsh-fusion/core";
import type { WhalePanelModel } from "../whale/types.js";
export interface NativePanelData {
 model:WhalePanelModel; tasks:TaskRecord[]; nodes:NodeRecord[]; teams:AgentTeamRecord[];
 error?:string; loaded:boolean;
}
export interface NativePanelSelection { kind:"task"|"host"|"team"; id:string; }
export interface NativePanelDetailsProps {backLabel?:string;selection:NativePanelSelection;data:NativePanelData;onBack:()=>void;onSelect:(selection:NativePanelSelection)=>void;}
export interface NativeWhalePanelProps {snapshotUrl?:string;sessionId?:string;visible?:boolean;}
