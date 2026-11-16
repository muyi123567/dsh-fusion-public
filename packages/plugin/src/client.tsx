import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
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
export const inject = ["slots", "sessions"] as const;

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
}

interface SlotsService {
  inject(slot: string, callback: () => unknown): () => void;
  register(options: { name: string; id: string; order: number }, component: ComponentType): unknown;
}

interface FusionClientContext {
  readonly slots?: SlotsService;
  readonly get?: (name: string) => unknown;
  readonly effect?: (callback: () => (() => void), label?: string) => unknown;
}

interface SessionsService {
  readonly list: { getState(): { readonly current?: string } };
  binding(sessionId: string): { readonly session?: {
    command(input: string): Promise<{ readonly kind: "success" | "error"; readonly text?: string }>;
  } } | undefined;
}

export function FusionLauncher() {
  return <button type="button" aria-label="打开鲸插件"
    onClick={() => window.dispatchEvent(new CustomEvent("dsh-fusion:toggle"))}
    style={{ minHeight: 32, width: "100%", border: 0, borderRadius: 7, background: "transparent", color: "inherit", textAlign: "left", padding: "0 10px", cursor: "pointer" }}>
    🐋 鲸
  </button>;
}

export function FusionOverlay({ roomCommand, loadWorkspace = nativeWorkspace, loader: providedLoader }: FusionWorkspaceProps & {
  loadWorkspace?: () => Promise<WorkspaceImport>;
  loader?: ReturnType<typeof createWorkspaceLoader>;
}) {
  const loader = useMemo(() => providedLoader ?? createWorkspaceLoader(loadWorkspace), [providedLoader, loadWorkspace]);
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [workspace, setWorkspace] = useState<WorkspaceImport>();
  const [error, setError] = useState<string>();
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Focus trap for the modal dialog: Tab and Shift+Tab
  // cycle within the overlay instead of wandering the
  // host page behind it. Candidates are only elements that
  // can actually take keyboard focus: not disabled (nor in
  // a disabled fieldset), not inside inert or aria-hidden
  // subtrees, and not hidden by attribute or style.
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const focusables = [...dialog.querySelectorAll<HTMLElement>(
      "button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])",
    )].filter((element) => {
      if (element.hasAttribute("disabled")) return false;
      if (element.closest("fieldset[disabled]") !== null) return false;
      // Inert via attribute or IDL property, on the element
      // or any ancestor.
      let ancestor: HTMLElement | null = element;
      while (ancestor !== null) {
        if (ancestor.hasAttribute("inert")) return false;
        if ((ancestor as HTMLElement & { inert?: boolean }).inert === true) return false;
        ancestor = ancestor.parentElement;
      }
      if (element.closest("[aria-hidden='true']") !== null) return false;
      if (element.hasAttribute("hidden")) return false;
      try {
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
      } catch {
        // Keep the candidate when style is unavailable.
      }
      return true;
    });
    if (focusables.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  // Dialog focus contract: on open, focus moves into the
  // overlay (its close button); on close, focus returns to
  // whatever the host page had focused before.
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement;
    closeButtonRef.current?.focus();
    return () => {
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, [open ]);

  useEffect(() => {
    const toggle = () => setOpen((current) => !current);
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // A nested mobile panel consumes this Escape; a second Escape closes Whale.
      if (dialogRef.current?.querySelector(".fusion-sidebar.is-mobile-open, .fusion-drawer.is-mobile-open")) return;
      setOpen(false);
    };
    window.addEventListener("dsh-fusion:toggle", toggle);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("dsh-fusion:toggle", toggle);
      window.removeEventListener("keydown", escape);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError(undefined);
    void loader.load().then((module) => {
      if (active && module !== undefined) setWorkspace(module);
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [open, attempt, loader]);

  if (!open) return null;
  const Workspace = workspace?.FusionWorkspace;
  return <div ref={dialogRef} onKeyDown={trapTab} data-dsh-fusion-overlay="true" role="dialog" aria-modal="true" aria-label="鲸 · 深海工作区" style={{ position: "fixed", inset: 0, zIndex: 9000, background: "#07131d" }}>
    <button ref={closeButtonRef} type="button" aria-label="关闭鲸插件" onClick={() => setOpen(false)}
      style={{ position: "fixed", top: 14, right: 14, zIndex: 9001, width: 40, height: 40, border: "1px solid #2b4658", borderRadius: 7, background: "#102533", color: "#dcecf4", cursor: "pointer" }}>×</button>
    {error !== undefined ? <div role="alert">鲸工作区加载失败：{error} <button type="button" onClick={() => setAttempt((value) => value + 1)}>重试</button></div>
      : Workspace === undefined ? <div role="status">正在加载鲸工作区…</div>
      : <Workspace {...(roomCommand === undefined ? {} : { roomCommand })} />}
  </div>;
}

export function apply(ctx: FusionClientContext = {}): void {
  const slotsValue = ctx.get?.("slots") ?? ctx.slots;
  if (slotsValue === undefined || slotsValue === null) throw new Error("DSH_FUSION_SLOTS_UNAVAILABLE");
  const slots = slotsValue as SlotsService;
  const sessions = ctx.get?.("sessions") as SessionsService | undefined;
  const roomCommand = sessions === undefined ? undefined : async (input: string): Promise<void> => {
    const sessionId = sessions.list.getState().current;
    if (sessionId === undefined) throw new Error("当前 DSH Session 不可用");
    const live = sessions.binding(sessionId)?.session;
    if (live === undefined) throw new Error("当前 DSH Session 未连接到命令服务");
    const result = await live.command(input);
    if (result.kind !== "success") throw new Error(result.text ?? "Room 命令执行失败");
  };
  const register = () => {
    const loader = createWorkspaceLoader(nativeWorkspace);
    const disposers: Array<() => void> = [];
    try {
      disposers.push(slots.inject("sidebar.footer.action", () => slots.register(
        { name: "sidebar.footer.action", id: "dsh-fusion.launcher", order: 95 }, FusionLauncher,
      )));
      const Overlay = () => <FusionOverlay loader={loader} {...(roomCommand === undefined ? {} : { roomCommand })} />;
      disposers.push(slots.inject("shell.overlay", () => slots.register(
        { name: "shell.overlay", id: "dsh-fusion.overlay", order: 30 }, Overlay,
      )));
    } catch (error) {
      loader.dispose();
      for (const dispose of disposers.reverse()) dispose();
      throw error;
    }
    return () => {
      loader.dispose();
      for (const dispose of disposers.reverse()) dispose();
    };
  };
  if (ctx.effect === undefined) register();
  else ctx.effect(register, "dsh-fusion: client slots");
}
