import type { WhalePanelModel } from "../types.js";
import type { OceanLife, OceanCue } from "./life-types.js";
const bound = <T extends {id:string}>(xs: T[]) => [...new Map(xs.map(x=>[x.id,x])).values()].slice(0,64);
export function projectOceanLife(model:WhalePanelModel, previous?:WhalePanelModel):OceanLife {
 const cues:OceanCue[]=[];
 const emit=(kind:OceanCue["kind"],entityId:string,label:string,state:unknown,teamId?:string)=>{
  if(cues.length<8)cues.push({id:JSON.stringify([kind,entityId,state]),kind,entityId,label,teamId});
 };
 const tasks=bound(model.krill).map(t=>({id:t.id,teamId:t.teamId,status:t.status,blocked:!!t.blocked||t.status==="failed"}));
 const hosts=bound(model.hosts).map(h=>({id:h.id,name:h.name,status:h.status,ssh:!!h.transports?.some(t=>t.toLowerCase().includes("ssh"))}));
 const subagents=bound(model.subagents??[]).map(s=>({...s}));
 const schedulesObserved=model.schedulesObserved===true;
 const schedules=schedulesObserved?bound(model.schedules??[]).map(s=>({...s})):[];
 const phase=model.freshness==="stale"?"stale":model.freshness==="unobserved"?"starting":"ready";
 if(!previous)emit("startup","ocean","海域缓入 · 等待来源",model.freshness);
 else if(model.freshness==="stale"&&previous.freshness!=="stale")emit("source-stale","ocean","失去观测","stale");
 else if(model.freshness==="current"&&previous.freshness==="current"){
  const oldTasks=new Map(previous.krill.map(t=>[t.id,t]));
  for(const t of bound(model.krill)){
   const old=oldTasks.get(t.id);if(!old)continue;
   const state=[t.status,!!t.blocked,t.revision??null];
   if((t.blocked||t.status==="failed")&&!(old.blocked||old.status==="failed"))emit("task-blocked",t.id,"工作受阻",state,t.teamId);
   else if(old.status!==t.status){
    if(t.status==="running"&&(old.status==="queued"||old.status==="claimed"))emit("task-start",t.id,"起航执行",state,t.teamId);
    if(t.status==="verifying")emit("task-verify",t.id,"待验收",state,t.teamId);
    if(t.status==="completed")emit("task-complete",t.id,"新完成 · 查看任务证据",state,t.teamId);
   }
  }
  const oldHosts=new Map(previous.hosts.map(h=>[h.id,h]));
  for(const h of hosts){
   const old=oldHosts.get(h.id);
   if(!h.ssh||!old?.transports?.some(t=>t.toLowerCase().includes("ssh")))continue;
   if(old.status==="offline"&&h.status==="online")emit("host-online",h.id,"SSH主机可达",h.status);
   if(old.status==="online"&&h.status==="offline")emit("host-offline",h.id,"SSH主机不可达",h.status);
  }
  const oldAgents=new Map((previous.subagents??[]).map(s=>[s.id,s]));
  for(const s of subagents){
   const old=oldAgents.get(s.id);if(!old||old.status===s.status)continue;
   if(s.status==="running")emit("subagent-start",s.id,"子代理协作中",s.status,s.parentId);
   if(old.status==="running")emit("subagent-stop",s.id,s.status==="failed"?"子代理错误":"子代理本轮停止",s.status,s.parentId);
  }
  if(previous.schedulesObserved&&schedulesObserved){
   const oldSchedules=new Map((previous.schedules??[]).map(s=>[s.id,s]));
   for(const s of schedules){const old=oldSchedules.get(s.id);if(old&&s.lastRunId&&old.lastRunId!==s.lastRunId)emit("schedule-trigger",s.id,"定时任务触发",s.lastRunId);}
  }
 }
 return {phase,tasks,hosts,subagents,schedules,schedulesObserved,cues};
}
