import { useEffect, useState, type ComponentType } from "react";
import { createWorkspaceLoader, type WorkspaceImport } from "./client.workspace-loader.js";
import type {
  FusionTaskViewAction,
  FusionTaskViewDefinition as CoreFusionTaskViewDefinition,
  FusionTaskViewProps,
  FusionTaskTopology,
  FusionTaskTopologyEdge,
  FusionTaskTopologyEntity,
  FusionTaskTopologyRelation,
} from "@dsh-fusion/core";
export const PLUGIN_ID = "dsh-fusion" as const;
export const inject = ["slots", "sessions", "sidebarRight", "sidebarRightTabs"] as const;

export type {
  FusionTaskViewAction,
  FusionTaskViewProps,
  FusionTaskTopology,
  FusionTaskTopologyEdge,
  FusionTaskTopologyEntity,
  FusionTaskTopologyRelation,
};

export type FusionTaskViewDefinition = CoreFusionTaskViewDefinition<
  ComponentType<FusionTaskViewProps>,
  ComponentType<any>
>;

export interface FusionTaskViewApi {
  major: 1;
  minor: 1;
}

export type FusionTaskViewMethod = "register" | "unregister" | "list";

export interface FusionTaskViewGlobal {
  version: 1;
  generation: number;
  readonly ready: boolean;
  api: FusionTaskViewApi;
  has(method: string): boolean;
  register(definition: FusionTaskViewDefinition): () => void;
  unregister(id: string): void;
  list(): readonly FusionTaskViewDefinition[];
}

declare global {
  interface Window {
    __DSH_FUSION_TASK_VIEWS__?: FusionTaskViewGlobal;
  }
}

declare const require: { async(path: string): Promise<WorkspaceImport> };
const nativeWorkspace = () => require.async("./client.workspace.js");


export interface FusionWorkspaceProps {
  roomCommand?: (input: string) => Promise<void>;
  sessionId?: string;
  visible?: boolean;
}
interface NativeTabProps { sessionId: string; useTabInfo(): { tab: { visible: boolean } }; }
interface SlotsService {
  inject(slot: string, callback: () => unknown): () => void;
  register(options: { name: string; id?: string; key?: string; order?: number }, component: ComponentType<any>): unknown;
}
interface FusionClientContext {
  readonly slots?: SlotsService;
  readonly get?: (name: string) => unknown;
  readonly effect?: (callback: () => (() => void), label?: string) => unknown;
}
export const PANEL_KIND = "dsh-fusion.panel";

export function FusionLauncher({ open, unavailable }: { open?: () => void; unavailable?: string }) {
  const [message, setMessage] = useState<string>();
  return <div><button type="button" aria-label="打开鲸面板" title="鲸" style={{
    display: "flex", alignItems: "center", gap: 6, width: "100%", minHeight: 28,
    padding: "4px 8px", border: 0, borderRadius: 6, background: "transparent",
    color: "var(--dsw-alias-label-primary)", font: "inherit", fontSize: 14,
    lineHeight: "20px", textAlign: "left", cursor: "pointer",
  }} onClick={() => {
    if (unavailable) setMessage(unavailable);
    else { try { open?.(); setMessage(undefined); } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); } }
  }}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 11c3 0 4-3 8-3s6 2 7 5l3-3v6l-3-1c-2 4-11 5-14 0-1-1-1-3-1-4Z" /><path d="M10 8V5m-2 1h4" /></svg><span>鲸</span></button>{message && <div role="status">{message}</div>}</div>;
}

export function FusionNativeTab({ sessionId, useTabInfo, loader }: NativeTabProps & {
  loader: ReturnType<typeof createWorkspaceLoader>;
}) {
  const { tab: { visible } } = useTabInfo();
  return visible ? <LoadedPanel key={sessionId} sessionId={sessionId} loader={loader} /> : null;
}
function LoadedPanel({ sessionId, loader }: { sessionId: string; loader: ReturnType<typeof createWorkspaceLoader> }) {
  const [workspace, setWorkspace] = useState<WorkspaceImport>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setError(undefined);
    void loader.load().then(module => { if (active) setWorkspace(module); }, reason => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [loader, attempt]);
  const Workspace = workspace?.FusionWorkspace;
  if (error) return <div role="alert">鲸面板加载失败：{error}<button onClick={() => setAttempt(value => value + 1)}>重试</button></div>;
  return Workspace ? <Workspace sessionId={sessionId} visible={true} /> : <div role="status">正在加载鲸面板…</div>;
}
export function apply(ctx: FusionClientContext = {}): void {
  const slots = (ctx.get?.("slots") ?? ctx.slots) as SlotsService | undefined;
  if (!slots) throw new Error("DSH_FUSION_SLOTS_UNAVAILABLE");
  const sidebarRight = ctx.get?.("sidebarRight") as { openTab(kind: string): unknown; commandTarget(): { readonly sessionId: string } | undefined } | undefined;
  const tabs = ctx.get?.("sidebarRightTabs") as { register(definition: unknown): () => void } | undefined;
  const register = () => {
    const loader = createWorkspaceLoader(nativeWorkspace);
    const disposers: Array<() => void> = [];
    try {
      const Launcher = () => <FusionLauncher {...(!sidebarRight || !tabs ? { unavailable: "当前 DSH 不支持原生右侧面板，请升级宿主。" } : { open: () => {
        if (sidebarRight.commandTarget() === undefined) throw new Error("请先选择一个 DSH 会话，再打开鲸面板。");
        sidebarRight.openTab(PANEL_KIND);
      } })} />;
      disposers.push(slots.inject("sidebar.footer.action", () => slots.register({ name: "sidebar.footer.action", id: "dsh-fusion.launcher", order: 95 }, Launcher)));
      if (sidebarRight && tabs) {
        disposers.push(tabs.register({ id: PLUGIN_ID, kind: PANEL_KIND, title: () => "鲸",
          guide: [{ id: "panel", order: 95, title: () => "鲸", description: () => "查看任务、主机、团队与海域" }] }));
        const Panel = (props: NativeTabProps) => <FusionNativeTab {...props} loader={loader} />;
        disposers.push(slots.inject("sidebar.right.pane.tab", () => slots.register({ name: "sidebar.right.pane.tab", key: PLUGIN_ID }, Panel)));
      }
    } catch (error) {
      loader.dispose(); for (const dispose of disposers.reverse()) dispose(); throw error;
    }
    return () => { loader.dispose(); for (const dispose of disposers.reverse()) dispose(); };
  };
  if (ctx.effect) ctx.effect(register, "dsh-fusion: native panel"); else register();
}
