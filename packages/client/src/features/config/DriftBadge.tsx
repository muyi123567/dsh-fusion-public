import { Check, CircleAlert } from "lucide-react";
import type { ConfigState } from "@dsh-fusion/core";

export function DriftBadge({ drift, state, offline = false }: { drift?: boolean; state?: ConfigState; offline?: boolean }) {
  const actualState = state ?? (drift ? "drift" : "current");
  return offline || actualState === "unknown" ? (
    <span className="fusion-warning"><CircleAlert size={13} /> {offline ? "离线 · 配置未验证" : "配置未验证"}</span>
  ) : actualState === "drift" ? (
    <span className="fusion-warning"><CircleAlert size={13} /> 配置漂移</span>
  ) : (
    <span className="fusion-ok"><Check size={13} /> 已应用</span>
  );
}
