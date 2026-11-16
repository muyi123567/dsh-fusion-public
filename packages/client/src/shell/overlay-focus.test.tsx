import { act, fireEvent, render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FusionApp } from "../app.js";
import { RightDrawer } from "./RightDrawer.js";
import { Sidebar } from "./Sidebar.js";
import { focusableElements } from "./focus-utils.js";

function stubViewport(matchesQuery: (query: string) => boolean) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: matchesQuery(query),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("focusableElements candidate filtering", () => {
  it("excludes hidden, inert, aria-hidden, disabled and disabled-fieldset elements", () => {
    render(
      <div data-testid="box">
        <button type="button">可用一</button>
        <button type="button" disabled>已禁用</button>
        <button type="button" hidden>隐藏属性</button>
        <button type="button" style={{ display: "none" }}>行内隐藏</button>
        <span aria-hidden="true"><button type="button">aria 隐藏</button></span>
        {/* React 18 drops the inert JSX prop; inert state is
            applied imperatively (as the app shell does). */}
        <span ref={(element) => { element?.setAttribute("inert", ""); }}><button type="button">inert 内</button></span>
        <fieldset disabled><button type="button">禁用字段集内</button></fieldset>
        <input type="hidden" />
        <button type="button" tabIndex={-1}>负 tabindex</button>
        <a href="#x">可用链接</a>
      </div>,
    );
    const box = screen.getByTestId("box");
    expect(focusableElements(box).map((element) => element.textContent)).toEqual(["可用一", "可用链接"]);
  });
});

function SidebarHarness() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div>
      <button ref={triggerRef} type="button" onClick={() => setOpen(true)}>打开导航-触发器</button>
      <Sidebar
        mode="bot"
        onModeChange={vi.fn()}
        bots={[]}
        groups={[]}
        nodes={[]}
        sessions={[]}
        selectedBotId=""
        onSelectBot={vi.fn()}
        onSelectNode={vi.fn()}
        onSelectSession={vi.fn()}
        mobileOpen={open}
        onCloseMobile={() => setOpen(false)}
      />
    </div>
  );
}

describe("mobile sidebar modal behaviour", () => {
  it("becomes a modal dialog with trapped focus and focus return at mobile widths", async () => {
    stubViewport((query) => query.includes("760"));
    render(<SidebarHarness />);
    const trigger = screen.getByRole("button", { name: "打开导航-触发器" });
    trigger.focus();
    await userEvent.click(trigger);

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    // Focus moved into the overlay (its close button is the
    // first focusable element).
    const close = screen.getByRole("button", { name: "关闭导航" });
    expect(close).toHaveFocus();

    const focusables = focusableElements(dialog);
    const last = focusables[focusables.length - 1]!;
    last.focus();
    expect(fireEvent.keyDown(dialog, { key: "Tab" })).toBe(false);
    expect(focusables[0]).toHaveFocus();
    expect(fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true })).toBe(false);
    expect(last).toHaveFocus();

    // Closing returns focus to the trigger.
    await userEvent.click(close);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("stays a plain aside at desktop widths even when mobileOpen is set", () => {
    stubViewport(() => false);
    render(<SidebarHarness />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("mobile drawer modal behaviour", () => {
  it("becomes a modal dialog at tablet widths", async () => {
    stubViewport((query) => query.includes("1120"));
    render(
      <RightDrawer
        mode="bot"
        bot={{
          id: "bot-1", providerId: "agent-teams", name: "Bot", role: "worker",
          model: "unknown", isMain: false, status: "idle",
        }}
        node={{
          id: "node-1", externalId: "node-1", providerId: "huawei-ssh", name: "Node",
          platform: "linux", roles: ["worker"], status: "online", transports: ["ssh"],
          capabilities: ["linux"], configState: "current",
        }}
        tasks={[]}
        mobileOpen
        onCloseMobile={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
  });
});

describe("app background inerting", () => {
  it("inerts the main region while the mobile sidebar is open and restores it on close", async () => {
    stubViewport((query) => query.includes("760"));
    const { container } = render(<FusionApp initialMode="bot" />);
    const main = container.querySelector("main")!;
    expect((main as HTMLElement & { inert?: boolean }).inert ?? false).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect((main as HTMLElement & { inert?: boolean }).inert).toBe(true);

    await userEvent.click(screen.getByRole("button", { name: "关闭浮层" }));
    expect((main as HTMLElement & { inert?: boolean }).inert ?? false).toBe(false);
  });
});

function stubMutableViewport(initialQuery: string, initialMatches: boolean) {
  const lists = new Map<string, {
    matches: boolean;
    listeners: Set<(event: { matches: boolean }) => void>;
  }>();
  if (initialMatches) lists.set(initialQuery, { matches: true, listeners: new Set() });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      let list = lists.get(query);
      if (list === undefined) {
        list = { matches: false, listeners: new Set() };
        lists.set(query, list);
      }
      const current = list;
      return {
        get matches() { return current.matches; },
        media: query,
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          current.listeners.add(listener);
        },
        removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          current.listeners.delete(listener);
        },
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
        onchange: null,
      };
    },
  });
  return {
    set(query: string, matches: boolean) {
      const list = lists.get(query);
      if (list === undefined) return;
      list.matches = matches;
      for (const listener of [...list.listeners]) listener({ matches });
    },
  };
}

describe("breakpoint transitions", () => {
  it("closes the mobile sidebar state when the viewport crosses above 760px so no orphan scrim remains", async () => {
    const viewport = stubMutableViewport("(max-width: 760px)", true);
    const { container } = render(<FusionApp initialMode="bot" />);
    await userEvent.click(screen.getByRole("button", { name: "打开导航" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭浮层" })).toBeInTheDocument();

    // Resize into the 761-1120 band: the sidebar becomes a
    // static column there, so the modal state — and with it
    // the fullscreen scrim — must not survive the crossing.
    act(() => viewport.set("(max-width: 760px)", false));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "关闭浮层" })).not.toBeInTheDocument();
    const main = container.querySelector("main")!;
    expect((main as HTMLElement & { inert?: boolean }).inert ?? false).toBe(false);
  });
});
