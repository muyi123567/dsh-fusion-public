import { useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, Search, Server, Waves } from "lucide-react";
import { WhaleGlyph } from "./WhaleGlyph.js";
import { WHALE_STATUS_TEXT, type WhaleDashboardProps, type WhaleKrill } from "./types.js";
import "./whale-bridge.css";

const ACTIVE = new Set(["claimed","running","verifying"]);
export function WhaleBridge({model,onOpenTask,onOpenHost,onNavigate}:WhaleDashboardProps){
 const [team,setTeam]=useState("");
 const [query,setQuery]=useState("");
 const [filter,setFilter]=useState<"all"|"active"|"attention">("all");
 const [expanded,setExpanded]=useState(false);
 const selected=model.pods.find(p=>p.id===team);
 const actualTeam=selected?.id??"";
 const hosts=useMemo(()=>new Map(model.hosts.map(h=>[h.id,h])),[model.hosts]);
 const teams=useMemo(()=>new Map(model.pods.map(p=>[p.id,p.name])),[model.pods]);
 const filtered=useMemo(()=>{
  const needle=query.trim().toLocaleLowerCase();
  const priority=(t:WhaleKrill)=>t.status==="failed"?0:t.blocked?1:t.status==="verifying"?2:ACTIVE.has(t.status)?3:4;
  return model.krill.filter(t=>{
   if(selected&&!selected.taskIds.includes(t.id))return false;
   if(filter==="active"&&!ACTIVE.has(t.status))return false;
   if(filter==="attention"&&!t.blocked&&t.status!=="failed"&&t.status!=="verifying")return false;
   return !needle||[t.title,t.id,t.teamId?teams.get(t.teamId):"",...t.hostIds.map(id=>hosts.get(id)?.name??id)].join(" ").toLocaleLowerCase().includes(needle);
  }).sort((a,b)=>priority(a)-priority(b));
 },[model.krill,selected,filter,query,hosts,teams]);
 const visible=expanded?filtered:filtered.slice(0,7);
 const stale=model.freshness!=="current";
 const blocked=model.krill.filter(t=>t.blocked).length;
 const unassigned=model.krill.filter(t=>t.teamId===undefined).length;
 function taskLabel(t:WhaleKrill){return WHALE_STATUS_TEXT[t.status]+(t.blocked?" · 受阻":"");}
 function selectTeam(id:string){setTeam(id===actualTeam?"":id);setExpanded(false);}
 return <div className="whale-bridge">
  <header className="wb-heading">
   <div><p className="wb-location"><Waves size={15}/>鲸 · 跨主机协作</p><h1>深海舰桥</h1><p className="wb-intro">鲸群各有航向，任务与异常在此汇流。</p></div>
   <button className="wb-primary" type="button" onClick={()=>onNavigate("tasks")}>进入任务列表<ArrowUpRight size={16}/></button>
  </header>
  <div className="wb-stats" aria-label="快照总览">
   <div><span>主机在线</span><strong>{model.summary.online}<small> / {model.summary.hosts}</small></strong></div>
   <div><span>协作鲸群</span><strong>{model.summary.teams}<small> 个团队</small></strong></div>
   <div><span>进行中的磷虾</span><strong>{model.summary.active}<small> 项任务</small></strong></div>
   <div className={blocked?"wb-attention-stat":""}><span>窗口内受阻</span><strong>{blocked}<small> 项任务</small></strong></div>
   <div className="wb-stats-note"><span className="wb-signal"/><span>{stale?"上次观测，待重新确认":"按收到的快照呈现"}<small>完成状态与证据分别查看</small></span></div>
  </div>
  <section className="wb-pods" aria-labelledby="wb-pod-heading">
   <div className="wb-section-title"><h2 id="wb-pod-heading">鲸群态势</h2><button className="wb-text" type="button" onClick={()=>onNavigate("runs")}>全部团队<ArrowRight size={14}/></button></div>
   {model.pods.length?<div className="wb-pod-grid">{model.pods.slice(0,6).map((p,index)=>{
    const related=model.krill.filter(t=>p.taskIds.includes(t.id));
    const alerts=related.filter(t=>t.blocked||t.status==="failed");
    return <button type="button" className="wb-pod" key={p.id} aria-pressed={actualTeam===p.id} aria-label={`筛选团队 ${p.name}`} onClick={()=>selectTeam(p.id)}>
     <div className="wb-pod-top"><span className="wb-pod-number">0{index+1} / WHALE</span><span className="wb-pod-state"><i/>{p.state==="archived"?"已归档":p.state==="staged"?"准备中":stale?"上次运行中":"协作中"}</span></div>
     <div className="wb-pod-identity"><WhaleGlyph size={95}/><div><h3>{p.name}</h3><p>{p.memberCount} 位成员 · {p.hostIds.length} 台关联主机</p></div><ArrowUpRight size={17}/></div>
     <div className="wb-krill-line" aria-label={`${related.length} 项已观测任务`}>{related.slice(0,36).map(t=><i key={t.id} className={`is-${t.blocked?"blocked":t.status}`} title={t.title+" · "+taskLabel(t)}/>)}{related.length===0?<span>尚无已观测任务</span>:null}</div>
     <div className="wb-pod-bottom"><span><b>{p.active}</b> 进行中</span><span><b>{p.completed}</b> 已完成</span><span className={alerts.length?"is-alert":""}>{alerts.length?alerts.length+" 项需留意":"查看任务"}<ArrowRight size={13}/></span></div>
    </button>;
   })}</div>:<div className="wb-empty-pods"><WhaleGlyph size={120}/><div><h3>{model.freshness==="unobserved"?"等待鲸群浮现":"还没有团队记录"}</h3><p>{model.krill.length?"已有任务仍在下方显示；不会推测其团队归属。":"连接团队来源后，在这里观察团队与细任务。"}</p><button type="button" className="wb-text" onClick={()=>onNavigate("setup")}>检查连接<ArrowRight size={14}/></button></div></div>}
   {model.summary.teams>model.pods.length||model.pods.length>6?<p className="wb-window-note">展示 {Math.min(6,model.pods.length)} / {model.summary.teams} 个团队；完整记录在运行中心。</p>:null}
  </section>
  <div className="wb-main-grid">
   <section className="wb-task-section" aria-labelledby="wb-task-heading">
    <div className="wb-section-title"><div><h2 id="wb-task-heading">磷虾任务</h2><p>细小的工作，汇成前进的力量。</p></div><span className="wb-total">{model.krill.length} 项已观测</span></div>
    <div className="wb-task-tools"><label className="wb-search"><Search size={15}/><input type="search" aria-label="搜索磷虾任务" value={query} placeholder="搜索任务、团队或主机" onChange={e=>{setQuery(e.target.value);setExpanded(false);}}/></label><label className="wb-team-select"><span className="wb-sr-only">筛选鲸群</span><select aria-label="筛选鲸群" value={actualTeam} onChange={e=>{setTeam(e.target.value);setExpanded(false);}}><option value="">全部鲸群</option>{model.pods.map(p=><option value={p.id} key={p.id}>{p.name}</option>)}</select></label></div>
    <div className="wb-task-filter" role="group" aria-label="任务状态筛选">{([["all","全部任务"],["active","进行中"],["attention","需留意"]] as const).map(([id,label])=><button type="button" key={id} aria-pressed={filter===id} onClick={()=>{setFilter(id);setExpanded(false);}}>{label}</button>)}{selected&&<button className="wb-clear-team" type="button" onClick={()=>setTeam("")}>清除 {selected.name} 筛选 ×</button>}</div>
    <div className="wb-task-columns" aria-hidden="true"><span>任务 / 团队</span><span>状态</span><span>进度</span><span>证据</span><span/></div>
    {visible.length?<ul className="wb-tasks">{visible.map(t=><li key={t.id}><button type="button" className="wb-task-row" onClick={()=>onOpenTask(t.id)} aria-label={`打开任务 ${t.title}`}>
     <span className="wb-task-identity"><i className={`wb-task-dot is-${t.blocked?"blocked":t.status}`}/><span><strong>{t.title}</strong><small>{t.teamId?teams.get(t.teamId)??"团队未在窗口内":"归属待确认"} · {t.hostIds.length?t.hostIds.map(id=>hosts.get(id)?.name??"未观测主机").join("、"):"未绑定主机"}</small></span></span>
     <span className={`wb-task-state is-${t.blocked?"blocked":t.status}`}>{taskLabel(t)}</span>
     <span className="wb-progress">{t.progress===undefined?<small>未报告</small>:<><span><i style={{width:t.progress+"%"}}/></span><small>{t.progress}%</small></>}</span>
     <span className="wb-evidence">{t.evidenceCount}<small> 份</small></span><ArrowUpRight size={15}/>
    </button></li>)}</ul>:<div className="wb-empty-tasks"><h3>{model.krill.length?"没有符合条件的任务":"海域安静，等待新的任务"}</h3><p>{model.krill.length?"调整搜索或筛选，继续探索。":"没有任务记录不代表任务已完成。"}</p><button type="button" className="wb-text" onClick={()=>{if(model.krill.length){setQuery("");setFilter("all");setTeam("");}else onNavigate("tasks");}}>{model.krill.length?"清除筛选":"打开任务列表"}<ArrowRight size={14}/></button></div>}
    <div className="wb-task-foot"><span>{stale?"上次快照 · ":""}{visible.length} / {filtered.length} 项{unassigned?" · "+unassigned+" 项归属待确认":""}</span>{!expanded&&filtered.length>visible.length?<button type="button" className="wb-text" onClick={()=>setExpanded(true)}>展开本页全部<ArrowRight size={14}/></button>:<button type="button" className="wb-text" onClick={()=>onNavigate("tasks")}>任务工作区<ArrowRight size={14}/></button>}</div>
   </section>
   <aside className="wb-side">
    <section className="wb-hosts" aria-labelledby="wb-host-heading"><div className="wb-section-title"><h2 id="wb-host-heading">主机海域</h2><Server size={15}/></div>
     {model.hosts.length?<ul>{model.hosts.slice(0,8).map(h=><li key={h.id}><button type="button" className="wb-host" onClick={()=>onOpenHost(h.id)} aria-label={`打开主机 ${h.name}`}>
      <div className="wb-host-title"><span><i className={`is-${h.status}`}/><strong>{h.name}</strong></span><small>{stale?"上次":""}{h.status==="online"?"在线":h.status==="degraded"?"降级":"离线"}</small></div>
      <div className="wb-host-load"><span>CPU <b>{h.cpu===undefined?"—":h.cpu+"%"}</b></span><span>{h.active} 个活动任务{h.capacity===undefined?" · 配额未知":" / "+h.capacity}</span></div>
      <div className="wb-host-bar"><i className={h.status==="offline"?"is-offline":""} style={{width:h.cpu===undefined?"0":h.cpu+"%"}}/></div>
      <span className={`wb-host-config is-${h.configState}`}>{h.configState==="current"?"配置一致":h.configState==="drift"?"配置漂移":"配置未验"}{h.memory===undefined?" · 内存未观测":" · 内存 "+h.memory+"%"}</span>
     </button></li>)}</ul>:<div className="wb-host-empty"><p>尚无主机快照</p><button type="button" className="wb-text" onClick={()=>onNavigate("setup")}>连接主机<ArrowRight size={14}/></button></div>}
     <button type="button" className="wb-host-all" onClick={()=>onNavigate("fleet")}>打开主机矩阵<ArrowRight size={14}/></button>
    </section>
    <section className="wb-alerts" aria-labelledby="wb-alert-heading"><div className="wb-section-title"><h2 id="wb-alert-heading">需要留意</h2><span>{model.attention.length}</span></div>{model.attention.length?<ul>{model.attention.slice(0,4).map(a=><li key={a.id}><button type="button" onClick={()=>a.taskId?onOpenTask(a.taskId):a.hostId?onOpenHost(a.hostId):onNavigate("setup")}><i className={a.severity}/><span><strong>{a.title}</strong><small>{a.detail}</small></span><ArrowUpRight size={13}/></button></li>)}</ul>:<p>{model.freshness==="current"?"当前窗口没有告警记录":"等待来源确认，暂不能判断告警"}</p>}{model.attention.length>4&&<button type="button" className="wb-text" onClick={()=>onNavigate("tasks")}>继续查看关注事项（窗口 {model.attention.length} 项）<ArrowRight size={14}/></button>}</section>
   </aside>
  </div>
  <footer className="wb-end"><span>鲸群之间有联系，细任务各有去处。</span><span>{model.summary.unknownHosts?model.summary.unknownHosts+" 个目标主机尚未观测":"团队与主机各自保留真实身份"}</span></footer>
 </div>;
}
