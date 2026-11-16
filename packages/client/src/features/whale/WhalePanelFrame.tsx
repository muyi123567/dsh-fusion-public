import type { ReactNode } from "react";
import type { WhaleDesign, WhalePanelModel } from "./types.js";
import "./whale-panel.css";

export function WhalePanelFrame({model,design,children,sourceWarnings=[]}:{model:WhalePanelModel;design:WhaleDesign;children:ReactNode;sourceWarnings?:string[]}){
 return <section className="whale-panel" data-whale-design={design} aria-label="鲸 · 深海工作面板">
  <div className="whale-panel-source">
   <span><i aria-hidden="true"/>{model.demo?"演示海域 · 合成数据":"当前工作区 · 来源快照"}</span>
   <span className={model.freshness==="current"&&sourceWarnings.length===0?"":"whale-source-warning"}>{sourceWarnings.length?"来源未就绪 · "+sourceWarnings.length+" 项":model.freshness==="stale"?"连接中断 · 保留上次观测":model.freshness==="unobserved"?"等待首次观测":"已接收快照"}</span>
  </div>{sourceWarnings.length>0&&<div className="whale-source-details" role="status">{sourceWarnings.map(w=><p key={w}>{w}</p>)}</div>}{children}
 </section>;
}
