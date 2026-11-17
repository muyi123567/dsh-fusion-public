import { Component, lazy, Suspense, useState } from "react";
import type { ComponentType, ReactNode } from "react";
import type { WhalePanelModel } from "../whale/types.js";
import styles from "./native-panel.module.css";

interface OceanProps {
 model: WhalePanelModel;
 visible: boolean;
 onSelectTeam: (id: string) => void;
}
type OceanLoader = () => Promise<{ default: ComponentType<OceanProps> }>;
const loadOcean: OceanLoader = () => import("./NativeOcean.js").then(module => ({default: module.NativeOcean}));

class OceanErrorBoundary extends Component<{children:ReactNode;onRetry:()=>void},{failed:boolean}> {
 state = {failed:false};
 static getDerivedStateFromError() { return {failed:true}; }
 render() {
  if (this.state.failed) return <div className={styles.message}>
   <p role="alert">海域加载失败。仍可切换任务、主机或团队。</p>
   <button type="button" onClick={this.props.onRetry}>重试海域</button>
  </div>;
  return this.props.children;
 }
}

/** Retry creates a fresh lazy type: React caches rejection on the previous one. */
export function NativeOceanBoundary({loader=loadOcean,...props}:OceanProps & {loader?:OceanLoader}) {
 const [attempt,setAttempt]=useState(()=>({id:0,Ocean:lazy(loader)}));
 const Ocean=attempt.Ocean;
 return <OceanErrorBoundary key={attempt.id} onRetry={()=>setAttempt(current=>({id:current.id+1,Ocean:lazy(loader)}))}>
  <Suspense fallback={<p className={styles.message}>正在载入海域…</p>}>
   <Ocean {...props}/>
  </Suspense>
 </OceanErrorBoundary>;
}
