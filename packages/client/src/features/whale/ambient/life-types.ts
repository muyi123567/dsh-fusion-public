export interface OceanSubagent { id:string; name:string; parentId?:string; status:"running"|"idle"|"failed"|"unknown"; }
export interface OceanSchedule { id:string; name:string; status:"waiting"|"running"|"failed"|"disabled"; nextRunAt?:string; lastRunId?:string; }
export interface OceanCue { id:string; kind:"startup"|"task-start"|"task-verify"|"task-complete"|"task-blocked"|"host-online"|"host-offline"|"subagent-start"|"subagent-stop"|"schedule-trigger"|"source-stale"; entityId:string; label:string; teamId?:string; }
export interface OceanLife {
 phase:"starting"|"ready"|"stale";
 subagents:OceanSubagent[];
 schedules:OceanSchedule[];
 schedulesObserved:boolean;
 hosts:Array<{id:string;name:string;status:"online"|"offline"|"degraded";ssh:boolean}>;
 tasks:Array<{id:string;teamId?:string;status:string;blocked:boolean}>;
 cues:OceanCue[];
}
