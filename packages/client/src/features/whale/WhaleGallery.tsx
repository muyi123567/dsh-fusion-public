import { useState } from "react";
import { ArrowLeft, ArrowUpRight, Waves, X } from "lucide-react";
import { WhalePanelFrame } from "./WhalePanelFrame.js";
import { WhaleAtlas } from "./WhaleAtlas.js";
import { WhaleBridge } from "./WhaleBridge.js";
import { WhaleCurrent } from "./WhaleCurrent.js";
const WHALE_DESIGNS=[{id:"atlas",name:"鲸群航图",description:"关系与全局态势"},{id:"bridge",name:"深海舰桥",description:"异常与执行工作台"},{id:"current",name:"洋流矩阵",description:"多团队任务泳道"}] as const;
import { WHALE_DEMO_MODEL } from "./demo-fixture.js";
import { WHALE_STATUS_TEXT, type WhaleDesign, type WhaleDestination } from "./types.js";
import { WhaleGlyph } from "./WhaleGlyph.js";
import "./whale-gallery.css";

function initialDesign():WhaleDesign {
 const value=new URLSearchParams(window.location.search).get("whaleDesign");
 return value==="atlas"||value==="current"?value:"bridge";
}
export function WhaleGallery(){
 const [design,setDesign]=useState<WhaleDesign>(initialDesign);
 const [detail,setDetail]=useState<{kind:"task"|"host"|"destination";id:string}>();
 const [empty,setEmpty]=useState(false);
 const [stale,setStale]=useState(false);
 const [unobserved,setUnobserved]=useState(false);
 const base=empty?{...WHALE_DEMO_MODEL,pods:[],hosts:[],krill:[],attention:[],summary:{hosts:0,online:0,teams:0,active:0,waiting:0,completed:0,unknownHosts:0}}:WHALE_DEMO_MODEL;
 const model={...base,freshness:stale?"stale" as const:unobserved?"unobserved" as const:base.freshness};
 const Dashboard=design==="atlas"?WhaleAtlas:design==="current"?WhaleCurrent:WhaleBridge;
 const task=detail?.kind==="task"?model.krill.find(t=>t.id===detail.id):undefined;
 const host=detail?.kind==="host"?model.hosts.find(h=>h.id===detail.id):undefined;
 const labels:Record<WhaleDestination,string>={tasks:"任务列表",fleet:"主机矩阵",sessions:"会话工作区",runs:"运行中心",setup:"连接设置"};
 return <div className="whale-gallery" data-model-id="whale-demo-v1">
  <header className="whale-gallery-header">
   <a className="whale-gallery-brand" href="https://github.com/muyi123567/dsh-fusion-public" aria-label="鲸插件源码"><WhaleGlyph size={54}/><span>鲸<span>WHΛLE</span></span></a>
   <nav aria-label="设计方案">{WHALE_DESIGNS.map(d=><button type="button" key={d.id} aria-pressed={design===d.id} onClick={()=>{setDesign(d.id);setDetail(undefined);const url=new URL(window.location.href);url.searchParams.set("whaleDesign",d.id);window.history.replaceState({},"",url);}}><b>{d.name}</b><small>{d.description}</small></button>)}</nav>
   <a className="whale-gallery-repo" href="https://github.com/muyi123567/dsh-fusion-public">查看源码<ArrowUpRight size={14}/></a>
  </header>
  <div className="whale-gallery-control"><span><Waves size={15}/>同一份合成数据 · 三种工作方式</span><div><label><input type="checkbox" checked={empty} onChange={e=>setEmpty(e.target.checked)}/>空海域</label><label><input type="checkbox" checked={stale} onChange={e=>setStale(e.target.checked)}/>连接中断</label><label><input type="checkbox" checked={unobserved} onChange={e=>setUnobserved(e.target.checked)}/>未观测</label></div></div>
  <script type="application/json" data-whale-model>{JSON.stringify(model).replaceAll("<","\\u003c")}</script>
  <main><WhalePanelFrame design={design} model={model}><Dashboard model={model} onOpenTask={id=>setDetail({kind:"task",id})} onOpenHost={id=>setDetail({kind:"host",id})} onNavigate={id=>setDetail({kind:"destination",id})}/></WhalePanelFrame></main>
  <footer className="whale-gallery-footer"><span>鲸群是团队 · 磷虾是细任务 · 洋流是联系</span><span>交互原型 / 无真实机器连接</span></footer>
  {detail!==undefined&&<section className="whale-gallery-detail" aria-label="预览详情">
   <button type="button" aria-label="关闭预览详情" onClick={()=>setDetail(undefined)}><X size={18}/></button>
   <small>合成数据 · 只读预览</small>
   <h2>{task?.title??host?.name??labels[detail.id as WhaleDestination]??detail.id}</h2>
   {task&&<><p>{WHALE_STATUS_TEXT[task.status]} · {task.blocked?"依赖受阻":task.dependencies+" 项依赖"} · {task.evidenceCount} 份证据</p><p>正式插件会打开该任务的状态、来源和证据详情。</p></>}
   {host&&<><p>{host.status==="online"?"在线":host.status==="degraded"?"降级":"离线"} · CPU {host.cpu===undefined?"未观测":host.cpu+"%"}</p><p>正式插件会打开该主机的连接、资源与权限详情。</p></>}
   {detail.kind==="destination"&&<p>正式插件中进入对应工作区。本展厅只供比较布局，不派发真实任务。</p>}
   <button type="button" className="whale-gallery-back" onClick={()=>setDetail(undefined)}><ArrowLeft size={14}/>返回面板</button>
  </section>}
 </div>;
}
