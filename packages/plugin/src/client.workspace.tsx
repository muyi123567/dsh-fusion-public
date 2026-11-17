import { NativeWhalePanel } from "../../client/src/features/native-panel/NativeWhalePanel.js";
import type { FusionWorkspaceProps } from "./client.js";
import { useClientStyles } from "./client.styles.js";
export function FusionWorkspace({ sessionId, visible }: FusionWorkspaceProps) {
  useClientStyles("workspace");
  return <NativeWhalePanel snapshotUrl="/plugins/dsh-fusion/state" {...(sessionId === undefined ? {} : { sessionId })} {...(visible === undefined ? {} : { visible })} />;
}
