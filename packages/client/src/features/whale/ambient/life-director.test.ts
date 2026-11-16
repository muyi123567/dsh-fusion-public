import {expect,it} from "vitest";
import type {WhalePanelModel} from "../types.js";
import {projectOceanLife as project} from "./life-director.js";
const m=(p:Partial<WhalePanelModel>={}):WhalePanelModel=>({pods:[],hosts:[],krill:[],attention:[],freshness:"current",demo:false,summary:{hosts:0,online:0,teams:0,active:0,waiting:0,completed:0,unknownHosts:0},...p});
const t=(status:WhalePanelModel["krill"][number]["status"])=>({id:"t",title:"t",status,hostIds:[],dependencies:0,evidenceCount:0});
it("first frame only starts; missing identities do not create edges",()=>{
 expect(project(m({krill:[t("completed")]})).cues.map(c=>c.kind)).toEqual(["startup"]);
 expect(project(m({krill:[t("running")]}),m()).cues).toEqual([]);
 expect(project(m(),m({krill:[t("running")]})).cues).toEqual([]);
});
it("deduplicates and uses stable semantic ids",()=>{
 const a=m({krill:[t("queued")]}),b=m({krill:[t("running"),t("running")]});
 expect(project(b,a).cues).toHaveLength(1);
 expect(project(b,a)).toEqual(project(b,a));
 expect(project(b,b).cues).toEqual([]);
 for(const [status,kind] of [["verifying","task-verify"],["completed","task-complete"],["failed","task-blocked"]] as const)
 expect(project(m({krill:[t(status)]}),b).cues[0]?.kind).toBe(kind);
});
it("suppresses stale work and recovery replay",()=>{
 const a=m({krill:[t("running")]}),b=m({freshness:"stale",krill:[t("completed")]});
 expect(project(b,a).cues.map(c=>c.kind)).toEqual(["source-stale"]);
 expect(project(b,b).cues).toEqual([]);
 expect(project(m({krill:[t("completed")]}),b).cues).toEqual([]);
});
it("SSH transport only means host reachability",()=>{
 const host={id:"h",name:"h",status:"offline",active:0,transports:["ssh"]} as WhalePanelModel["hosts"][number];
 const a=m({hosts:[host]}),b=m({hosts:[{...host,status:"online"}]});
 expect(project(b,a).cues[0]?.label).toBe("SSH主机可达");
 expect(project(a,b).cues[0]?.kind).toBe("host-offline");
 expect(project(m({hosts:[{...host,status:"online",transports:["http"]}]}),a).cues).toEqual([]);
});
it("idle subagent stops without completing a task",()=>{
 const a=m({subagents:[{id:"a",name:"a",status:"running"}]}),b=m({subagents:[{id:"a",name:"a",status:"idle"}]});
 expect(project(b,a).cues.map(c=>c.kind)).toEqual(["subagent-stop"]);
});
it("requires observed schedule and new lastRunId",()=>{
 const s={id:"s",name:"s",status:"waiting" as const,lastRunId:"1"};
 const a=m({schedulesObserved:true,schedules:[s]}),b=m({schedulesObserved:true,schedules:[{...s,lastRunId:"2"}]});
 expect(project(b,a).cues.map(c=>c.kind)).toEqual(["schedule-trigger"]);
 expect(project(a,a).cues).toEqual([]);
 expect(project(m({schedules:[s]})).schedules).toEqual([]);
});
it("bounds projections and cues",()=>{
 const krill=Array.from({length:100},(_,i)=>({...t("queued"),id:String(i)}));
 const a=m({krill}),b=m({krill:krill.map(x=>({...x,status:"running"}))});
 expect(project(b,a).tasks).toHaveLength(64);
 expect(project(b,a).cues).toHaveLength(8);
});
