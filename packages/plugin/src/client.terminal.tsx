import type { ComponentProps } from "react";
import { TerminalWindow as NativeTerminalWindow } from "../../client/src/features/terminal/TerminalWindow.js";
import { useClientStyles } from "./client.styles.js";

export function TerminalWindow(props: ComponentProps<typeof NativeTerminalWindow>) {
  useClientStyles("terminal");
  return <NativeTerminalWindow {...props} />;
}
