import type {OceanSubagent,OceanSchedule} from "./ambient/life-types.js";
import type { TaskStatus, NodeStatus, ConfigState } from "@dsh-fusion/core";

export type WhaleDestination = "tasks" | "fleet" | "sessions" | "runs" | "setup";
export type WhaleDesign = "atlas" | "bridge" | "current";
export interface WhaleKrill {
  id: string; title: string; status: TaskStatus; teamId?: string; hostIds: string[];
  progress?: number; dependencies: number; evidenceCount: number; revision?: number; blocked?: boolean;
}
export interface WhalePod {
  id: string; name: string; providerId: string; workspace: string;
  state: "running" | "staged" | "archived"; memberCount: number;
  taskIds: string[]; hostIds: string[]; active: number; completed: number; blocked: number;
}
export interface WhaleHost {
 transports?:string[];
  id: string; name: string; status: NodeStatus; configState: ConfigState;
  cpu?: number; memory?: number; active: number; capacity?: number; owner?: string;
}
export interface WhaleAttention {
  id: string; title: string; detail: string; severity: "warning" | "error";
  taskId?: string; hostId?: string;
}
export interface WhalePanelModel {
 subagents?:OceanSubagent[];
 schedules?:OceanSchedule[];
 schedulesObserved?:boolean;
  pods: WhalePod[]; hosts: WhaleHost[]; krill: WhaleKrill[]; attention: WhaleAttention[];
  freshness: "current" | "stale" | "unobserved"; demo: boolean;
  summary: { hosts: number; online: number; teams: number; active: number; waiting: number; completed: number; unknownHosts: number };
}
export interface WhaleDashboardProps {
  model: WhalePanelModel;
  onOpenTask: (taskId: string) => void;
  onOpenHost: (hostId: string) => void;
  onNavigate: (destination: WhaleDestination) => void;
}
export const WHALE_STATUS_TEXT: Record<TaskStatus,string> = {
  queued: "等待中", claimed: "已领取", running: "执行中", verifying: "待验收",
  completed: "已完成", failed: "失败", cancelled: "已取消",
};
