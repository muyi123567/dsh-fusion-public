import { FusionApp } from "../../client/src/app.js";
import type { FusionWorkspaceProps } from "./client.js";
import { useClientStyles } from "./client.styles.js";

export function FusionWorkspace(props: FusionWorkspaceProps) {
  useClientStyles("workspace");
  return <FusionApp initialMode="ocean" snapshotUrl="/plugins/dsh-fusion/state" {...props} />;
}
