import { Component, lazy, Suspense, useState, type ReactNode } from "react";
import { WhaleBridge } from "./WhaleBridge.js";
import { WhalePanelFrame } from "./WhalePanelFrame.js";
import type { WhaleDashboardProps } from "./types.js";
const LivingPanel=lazy(async()=>{const module=await import("./ambient/WhaleLivingPanel.js");return {default:module.WhaleLivingPanel};});
class HabitatBoundary extends Component<{children:ReactNode;onBack:()=>void},{failed:boolean}>{
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<div className="whale-view-loading" role="status">海域暂时无法打开。<button type="button" onClick={this.props.onBack}>返回舰桥</button></div>:this.props.children;}
}
export function WhalePanel(props:WhaleDashboardProps & {sourceWarnings?:string[]}){
 const [living,setLiving]=useState(false);
 return <WhalePanelFrame model={props.model} design="bridge" {...(props.sourceWarnings===undefined?{}:{sourceWarnings:props.sourceWarnings})}>
  <nav className="whale-view-switch" aria-label="面板视图"><button type="button" aria-pressed={!living} onClick={()=>setLiving(false)}>深海舰桥</button><button type="button" aria-pressed={living} onClick={()=>setLiving(true)}>鲸栖海域</button></nav>
  {living?<HabitatBoundary onBack={()=>setLiving(false)}><Suspense fallback={<div className="whale-view-loading" role="status">正在打开海域…</div>}><LivingPanel {...props}/></Suspense></HabitatBoundary>:<WhaleBridge {...props}/>}
 </WhalePanelFrame>;
}
