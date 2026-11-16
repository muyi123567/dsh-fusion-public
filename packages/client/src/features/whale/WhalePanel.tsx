import { WhaleBridge } from "./WhaleBridge.js";
import { WhalePanelFrame } from "./WhalePanelFrame.js";
import type { WhaleDashboardProps } from "./types.js";

export function WhalePanel(props:WhaleDashboardProps & {sourceWarnings?:string[]}){
 return <WhalePanelFrame model={props.model} design="bridge" {...(props.sourceWarnings===undefined?{}:{sourceWarnings:props.sourceWarnings})}><WhaleBridge {...props}/></WhalePanelFrame>;
}
