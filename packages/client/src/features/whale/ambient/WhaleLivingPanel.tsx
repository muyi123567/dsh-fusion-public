import { useState } from "react";
import { WHALE_STATUS_TEXT, type WhaleDashboardProps } from "../types.js";
import type { HabitatQuality } from "./contracts.js";
import { WhaleHabitat } from "./WhaleHabitat.js";
import "./whale-living-panel.css";

export function WhaleLivingPanel({model,onOpenTask,onOpenHost,onNavigate}:WhaleDashboardProps) {
 const [quality,setQuality]=useState<HabitatQuality>("auto");
 const [playing,setPlaying]=useState(true);
 const [tab,setTab]=useState("tasks");
 const [query,setQuery]=useState("");
 const [team,setTeam]=useState("");
 const [expanded,setExpanded]=useState(false);
 const [scene,setScene]=useState("loading");
 const selected=model.pods.find(p=>p.id===team);
 const tasks=model.krill.filter(t=>(!selected||selected.taskIds.includes(t.id))&&t.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
 const visible=expanded?tasks:tasks.slice(0,8);
 const observed=model.freshness==="current";
 return <section className="wlp" aria-label="鲸栖海域">
  <header><div><strong>鲸栖海域</strong><span>{model.freshness==="unobserved"?"未观测 · 等待来源":observed?"已收到当前快照":"陈旧快照 · 待重新确认"}</span>{model.demo&&<b className="wlp-demo">合成展示数据</b>}</div><div><label>画质 <select value={quality} onChange={e=>setQuality(e.target.value as HabitatQuality)}><option value="auto">自动 auto</option><option value="balanced">平衡 balanced</option><option value="eco">节能 eco</option><option value="still">静态 still</option></select></label><button type="button" aria-pressed={!playing} onClick={()=>setPlaying(v=>!v)}>{playing?"暂停":"继续"}</button></div></header>
  <div className="wlp-ocean"><WhaleHabitat activity={{active:model.summary.active,blocked:model.krill.filter(t=>t.blocked||t.status==="failed").length,completed:model.summary.completed,observed}} quality={quality} playing={playing} className="wlp-habitat" onStateChange={setScene}/><div className="wlp-caption">深海 · 持续巡游<small>{quality==="still"?"静态海域":!playing?"已暂停":scene==="error"?"海域暂不可用，下方任务仍可操作":scene==="loading"?"海域加载中":"活动来自收到的快照"}</small></div></div>
  <div className="wlp-summary"><span>活动任务 {model.summary.active}</span><span>已完成 {model.summary.completed}</span><span>在线主机 {model.summary.online}/{model.summary.hosts}</span>{!observed&&<span>上次观测值不代表当前运行状态</span>}</div>
  <nav aria-label="海域记录">{([["teams","团队",model.pods.length],["tasks","任务",model.krill.length],["hosts","主机",model.hosts.length],["attention","需关注",model.attention.length]] as const).map(([id,label,count])=><button type="button" key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label} {count}</button>)}</nav>
  <div className="wlp-records">
  {tab==="tasks"&&<><div className="wlp-tools"><input type="search" aria-label="搜索任务" placeholder="搜索任务名称" value={query} onChange={e=>{setQuery(e.target.value);setExpanded(false);}}/><select aria-label="筛选团队" value={selected?.id??""} onChange={e=>{setTeam(e.target.value);setExpanded(false);}}><option value="">全部团队</option>{model.pods.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select><button type="button" onClick={()=>onNavigate("tasks")}>任务工作区 ↗</button></div>
  {visible.length?<ul>{visible.map(t=><li key={t.id}><button type="button" className="wlp-row" onClick={()=>onOpenTask(t.id)}><span><strong>{t.title}</strong><small>{model.pods.find(p=>p.id===t.teamId)?.name??"团队归属未确认"} · {t.hostIds.length} 台关联主机 · {t.evidenceCount} 份证据</small></span><span>{WHALE_STATUS_TEXT[t.status]}{t.blocked?" · 受阻":""}<small>{t.progress===undefined?"进度未报告":t.progress+"%"}</small></span></button></li>)}</ul>:<p>{model.freshness==="unobserved"?"尚未观测到任务，请检查来源连接。":model.krill.length?"没有匹配任务，请调整搜索或团队筛选。":"当前快照没有任务记录；这不代表工作已完成。"}</p>}
  {tasks.length>visible.length&&<button type="button" onClick={()=>setExpanded(true)}>展开其余 {tasks.length-visible.length} 项任务</button>}</>}
  {tab==="teams"&&<><button type="button" onClick={()=>onNavigate("runs")}>全部团队与运行 ↗</button>{model.pods.length?<ul>{model.pods.map(p=><li key={p.id}><button type="button" className="wlp-row" onClick={()=>{setTeam(p.id);setQuery("");setExpanded(false);setTab("tasks");}}><span><strong>{p.name}</strong><small>{p.memberCount} 位成员 · {p.taskIds.length} 项关联任务</small></span><span>查看任务 →</span></button></li>)}</ul>:<p>尚无团队记录，任务仍可独立查看。</p>}</>}
  {tab==="hosts"&&<><button type="button" onClick={()=>onNavigate("fleet")}>主机矩阵 ↗</button>{model.hosts.length?<ul>{model.hosts.map(h=><li key={h.id}><button type="button" className="wlp-row" onClick={()=>onOpenHost(h.id)}><span><strong>{h.name}</strong><small>{h.active} 项活动任务 · CPU {h.cpu===undefined?"未观测":h.cpu+"%"}</small></span><span>{h.status==="online"?"在线":h.status==="degraded"?"降级":"离线"}</span></button></li>)}</ul>:<p>尚无主机快照。</p>}</>}
  {tab==="attention"&&(model.attention.length?<ul>{model.attention.map(a=><li key={a.id}><button type="button" className="wlp-row" onClick={()=>a.taskId?onOpenTask(a.taskId):a.hostId?onOpenHost(a.hostId):onNavigate("setup")}><span><strong>{a.title}</strong><small>{a.detail}</small></span><span>查看 ↗</span></button></li>)}</ul>:<p>{observed?"当前快照没有关注事项。":"来源尚未确认，暂不能判断是否存在异常。"}</p>)}
  {!observed&&<button type="button" onClick={()=>onNavigate("setup")}>检查来源连接 ↗</button>}
  </div>
 </section>;
}
