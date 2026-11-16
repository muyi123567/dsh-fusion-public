import { WhaleLivingPanel as Panel } from "../../client/src/features/whale/ambient/WhaleLivingPanel.js";
import type { WhaleDashboardProps } from "../../client/src/features/whale/types.js";
import { useClientStyles } from "./client.styles.js";
export function WhaleLivingPanel(props:WhaleDashboardProps){useClientStyles("habitat");return <Panel {...props}/>;}

