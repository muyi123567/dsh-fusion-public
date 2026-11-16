import { useRef, useState, useMemo } from "react";
import { WHALE_STATUS_TEXT, type WhaleDashboardProps } from "../types.js";
import type { HabitatPod, HabitatQuality, HabitatView } from "./contracts.js";
import { WhaleHabitat } from "./WhaleHabitat.js";
import "./whale-living-panel.css";

import { projectOceanLife } from "./life-director.js";
import type { WhalePanelModel } from "../types.js";
type Panel = "teams" | "tasks" | "hosts" | "attention" | "context";
export function WhaleLivingPanel({model,onOpenTask,onOpenHost,onNavigate}:WhaleDashboardProps) {
 const cache=useRef<{model:WhalePanelModel;life:ReturnType<typeof projectOceanLife>}>();
 const life=useMemo(()=>{
  if(cache.current?.model===model)return cache.current.life;
  const value=projectOceanLife(model,cache.current?.model);
  cache.current={model,life:value};return value;
 },[model]);
 const [quality,setQuality]=useState<HabitatQuality>(() => {
  const v=typeof window==="undefined"?null:new URLSearchParams(window.location.search).get("quality");
  return v==="balanced"||v==="eco"||v==="still"?v:"auto";
 });
 const [playing,setPlaying]=useState(true);
 const [view,setView]=useState<HabitatView>("deep");
 const [panel,setPanel]=useState<Panel|null>(null);
 const [team,setTeam]=useState("");
 const [page,setPage]=useState(0);
 const [query,setQuery]=useState("");
 const [scene,setScene]=useState("loading");
 const closeRef=useRef<HTMLButtonElement>(null);
 const openerRef=useRef<HTMLButtonElement|null>(null);
 const observed=model.freshness==="current";
 const pods:HabitatPod[]=model.pods.map(p=>{
  const tasks=model.krill.filter(t=>p.taskIds.includes(t.id));
  return {id:p.id,name:p.name,active:tasks.filter(t=>["claimed","running","verifying"].includes(t.status)).length,blocked:tasks.filter(t=>t.blocked||t.status==="failed").length,completed:tasks.filter(t=>t.status==="completed").length,observed};
 });
 const lastPage=Math.max(0,Math.ceil(pods.length/3)-1);
 const currentPage=Math.min(page,lastPage);
 const visiblePods=pods.slice(currentPage*3,currentPage*3+3);
 const selected=model.pods.find(p=>p.id===team);
 const tasks=model.krill.filter(t=>(!selected||selected.taskIds.includes(t.id))&&t.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const hosts=selected?model.hosts.filter(h=>selected.hostIds.includes(h.id)):model.hosts;
 const activity={active:model.summary.active,blocked:model.krill.filter(t=>t.blocked||t.status==="failed").length,completed:model.summary.completed,observed};
 function open(next:Panel,opener?:HTMLButtonElement) {
  if(opener) openerRef.current=opener;
  setPanel(next);
  requestAnimationFrame(()=>closeRef.current?.focus());
 }
 function close() {setPanel(null);openerRef.current?.focus();}
 function selectPod(id:string,opener?:HTMLButtonElement) {
  const index=pods.findIndex(p=>p.id===id);
  if(index<0)return;
  setTeam(id);setPage(Math.floor(index/3));setQuery("");open("tasks",opener);
 }
 const source=model.freshness==="unobserved"?"未观测 · 等待来源":observed?"当前快照":"陈旧 · 上次观测";
 const state=quality==="still"||scene==="still"?"静态海域":!playing?"海域已暂停":scene==="error"?"海域加载失败 · 记录仍可操作":scene==="loading"?"海域加载中":view==="surface"?"自然呼吸不代表任务完成":"自然巡游 · 状态以记录为准";
 const titles={teams:"团队",tasks:"任务",hosts:"主机",attention:"需关注",context:"情境"};
 return <section className="wlp" aria-label="鲸群海域">
  <WhaleHabitat life={life} pods={visiblePods} view={view} selectedPodId={selected?.id??""} onSelectPod={id=>selectPod(id)} activity={activity} quality={quality} playing={playing} className="wlp-habitat" onStateChange={setScene}/>
  <header className="wlp-top"><div className="wlp-brand"><strong>鲸 · Whale</strong><span>{source}</span>{model.demo&&<b className="wlp-demo">合成展示</b>}</div>
   <div className="wlp-controls"><div role="group" aria-label="海域视角"><button type="button" aria-label="深海遨游" aria-pressed={view==="deep"} onClick={()=>setView("deep")}>深海</button><button type="button" aria-label="海面呼吸" aria-pressed={view==="surface"} onClick={()=>setView("surface")}>海面</button></div>
   <select aria-label="海域画质" value={quality} onChange={e=>setQuality(e.target.value as HabitatQuality)}><option value="auto">自动</option><option value="balanced">平衡</option><option value="eco">节能</option><option value="still">静态</option></select><button type="button" aria-label={playing?"暂停海域":"继续海域"} aria-pressed={!playing} onClick={()=>setPlaying(v=>!v)}>{playing?"暂停":"继续"}</button></div>
  </header>
  <div className="wlp-cues" aria-live="polite">{life.cues.map(c=><span key={c.id} data-cue-kind={c.kind} data-entity-id={c.entityId}>{c.label}</span>)}</div>
  {!pods.length&&<div className="wlp-empty"><strong>安静海域，等待鲸群</strong><p>{model.freshness==="unobserved"?"尚未观测到团队来源。":"当前快照没有团队记录。"}</p><button type="button" onClick={()=>onNavigate("setup")}>连接团队来源</button></div>}
  {panel&&<aside className="wlp-panel" aria-label={titles[panel]+"浮层"} onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();close();}}}>
   <div className="wlp-panel-head"><div><h2>{titles[panel]}</h2><small>{selected?selected.name:"全部团队"} · {source}</small></div><button ref={closeRef} type="button" aria-label="关闭浮层" onClick={close}>关闭 ×</button></div>
   <div className="wlp-panel-body">
   {panel==="context"&&<><p>{model.demo?"合成数据 · 不派发真实任务":source} · 接入状态只读</p><details><summary>海域意象图例</summary><p>鲸群：团队；海豚：子代理；磷虾：细任务；海鸥：定时任务；航标：SSH。</p><p>呼吸不代表完成，SSH可达不代表任务成功。</p></details><h3>SSH 航标</h3>{life.hosts.filter(h=>h.ssh).map(h=><p key={h.id}>{h.name} · {h.id} · {observed?h.status:"失去观测 / 尚未观测"}</p>)}{!life.hosts.some(h=>h.ssh)&&<p>SSH 来源未接入</p>}<h3>子代理</h3>{life.subagents.map(a=><p key={a.id}>{a.name} · {a.id} · {a.status}</p>)}{!life.subagents.length&&<p>未接入子代理记录</p>}<h3>定时任务</h3>{life.schedulesObserved?life.schedules.map(a=><p key={a.id}>{a.name} · {a.id} · {a.status}<small>最近运行 {a.lastRunId??"尚无"} · 下次 {a.nextRunAt??"未报告"}</small></p>):<p>定时来源未接入</p>}</>}
   {panel==="tasks"&&<><div className="wlp-tools"><input type="search" aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={e=>setQuery(e.target.value)}/><button type="button" onClick={()=>setTeam("")}>全部团队</button></div>
    {tasks.length?<ul>{tasks.map(t=><li key={t.id}><button type="button" className="wlp-row" aria-label={"打开任务 "+t.title} data-task-id={t.id} onClick={()=>onOpenTask(t.id)}><strong>{t.title}</strong><span>{WHALE_STATUS_TEXT[t.status]}{t.blocked?" · 受阻":""}</span><small>{t.progress===undefined?"进度未报告":t.progress+"%"} · {t.evidenceCount} 份证据 · {t.hostIds.length} 台主机</small></button></li>)}</ul>:<p>{model.freshness==="unobserved"?"任务尚未观测。":"当前筛选没有任务记录，不代表工作已完成。"}</p>}
    <button type="button" onClick={()=>onNavigate("tasks")}>打开任务工作区 ↗</button></>}
   {panel==="teams"&&<><ul>{pods.map(p=><li key={p.id}><button type="button" className="wlp-row" aria-pressed={team===p.id} onClick={e=>selectPod(p.id,e.currentTarget)}><strong>{p.name}</strong><small>{p.active} 活动 · {p.blocked} 受阻/失败 · {p.completed} 完成</small></button></li>)}</ul>{!pods.length&&<p>尚无团队记录。</p>}<button type="button" onClick={()=>onNavigate("runs")}>团队与运行 ↗</button></>}
   {panel==="hosts"&&<><ul>{hosts.map(h=><li key={h.id}><button type="button" className="wlp-row" onClick={()=>onOpenHost(h.id)}><strong>{h.name}</strong><span>{h.status==="online"?"在线":h.status==="degraded"?"降级":"离线"}</span><small>{h.active} 活动任务 · CPU {h.cpu===undefined?"未观测":h.cpu+"%"}</small></button></li>)}</ul>{!hosts.length&&<p>尚无关联主机快照。</p>}<button type="button" onClick={()=>onNavigate("fleet")}>主机矩阵 ↗</button></>}
   {panel==="attention"&&(model.attention.length?<ul>{model.attention.map(a=><li key={a.id}><button type="button" className="wlp-row" onClick={()=>a.taskId?onOpenTask(a.taskId):a.hostId?onOpenHost(a.hostId):onNavigate("setup")}><strong>{a.title}</strong><small>{a.detail}</small></button></li>)}</ul>:<p>{observed?"当前快照没有关注事项。":"来源尚未确认，暂不能判断异常。"}</p>)}
   {!observed&&<button type="button" onClick={()=>onNavigate("setup")}>检查来源连接 ↗</button>}
   </div>
  </aside>}
  <footer className="wlp-bottom"><div className="wlp-state"><span>{state}</span><span>{!observed?"工作提示待来源确认":model.summary.active+" 活动任务 · "+model.summary.online+" 台在线主机"}</span></div>
   <div className="wlp-team-strip" aria-label="海域团队选择"><button type="button" aria-label="上一组团队" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}>‹</button><div className="wlp-team-names">{visiblePods.map(p=><button key={p.id} data-team-id={p.id} type="button" aria-pressed={team===p.id} onClick={e=>selectPod(p.id,e.currentTarget)}>{p.name}</button>)}</div><button type="button" aria-label="下一组团队" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}>›</button><span>{visiblePods.length} / {pods.length} 团队{pods.length>3?" · 第 "+(currentPage+1)+" 组":""}</span></div>
   <nav aria-label="海域记录">{(["teams","tasks","hosts","attention","context"] as const).map(id=><button key={id} type="button" aria-label={titles[id]} aria-expanded={panel===id} aria-pressed={panel===id} onClick={e=>panel===id?close():open(id,e.currentTarget)}>{titles[id]} <span>{id==="teams"?model.pods.length:id==="tasks"?model.krill.length:id==="hosts"?model.hosts.length:id==="attention"?model.attention.length:""}</span></button>)}</nav>
  </footer>
 </section>;
}
