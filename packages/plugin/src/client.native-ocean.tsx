import type { ComponentProps } from "react";
import { NativeOcean as Panel } from "../../client/src/features/native-panel/NativeOcean.js";
import { useClientStyles } from "./client.styles.js";

/** Arrives only after the user selects the native panel's sea view. */
export function NativeOcean(props: ComponentProps<typeof Panel>) {
  useClientStyles("native-ocean");
  return <Panel {...props} />;
}
