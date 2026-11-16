import { useEffect } from "react";

declare const __DSH_FUSION_WORKSPACE_CSS__: string;

/** Styles share the mounted capability's lifetime, including native hot unload. */
export function useClientStyles(chunk: string) {
  useEffect(() => {
    let css: string;
    try { css = __DSH_FUSION_WORKSPACE_CSS__; } catch { return; }
    const style = document.createElement("style");
    style.dataset.plugin = "dsh-fusion";
    style.dataset.pluginCss = `dsh-fusion.${chunk}`;
    style.textContent = css;
    document.head.appendChild(style);
    return () => { style.remove(); };
  }, [chunk]);
}
