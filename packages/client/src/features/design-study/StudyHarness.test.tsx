import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StudyHarness } from "./StudyHarness.js";

function setReducedMotion(reduced: boolean) {
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation((query: string) => ({
    matches: query === "(prefers-reduced-motion: reduce)" ? reduced : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })));
}

describe("study presentation tour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setReducedMotion(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays five truth-preserving stages only after explicit start and ends without claiming execution", async () => {
    const { container } = render(<StudyHarness />);
    const pane = container.querySelector<HTMLElement>("[data-design-pane]")!;

    expect(screen.queryByRole("status", { name: /前端展示/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "快速展示" }));
    expect(pane).toHaveAttribute("data-presentation-step", "list");
    expect(pane).toHaveAttribute("data-view", "list");

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(pane).toHaveAttribute("data-presentation-step", "detail");
    expect(pane).toHaveAttribute("data-view", "detail");
    expect(screen.getByText("来源状态：")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(pane).toHaveAttribute("data-presentation-step", "gap");
    expect(screen.getByText("独立审查结论未提供")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(pane).toHaveAttribute("data-presentation-step", "evidence");
    expect(screen.getByRole("heading", { name: "来源证据" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(pane).toHaveAttribute("data-presentation-step", "ending");
    expect(screen.getByRole("status", { name: /前端展示/ })).toHaveTextContent("独立审查未提供 · 未执行任务");
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("status", { name: /前端展示/ })).toHaveTextContent("演示结束");
  });

  it("stops the guided tour immediately when the viewer interacts with the task panel", async () => {
    const { container } = render(<StudyHarness />);
    const pane = container.querySelector<HTMLElement>("[data-design-pane]")!;
    fireEvent.click(screen.getByRole("button", { name: "快速展示" }));
    fireEvent.click(screen.getByRole("button", { name: /复核会话恢复补丁/ }));
    expect(screen.getByRole("button", { name: "快速展示" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
    expect(pane).toHaveAttribute("data-presentation-step", "idle");
    expect(pane).toHaveAttribute("data-view", "detail");
  });

  it("uses manual steps when reduced motion is requested", async () => {
    setReducedMotion(true);
    const { container } = render(<StudyHarness />);
    const pane = container.querySelector<HTMLElement>("[data-design-pane]")!;
    fireEvent.click(screen.getByRole("button", { name: "快速展示" }));
    expect(pane).toHaveAttribute("data-presentation-step", "list");
    expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(12000); });
    expect(pane).toHaveAttribute("data-presentation-step", "list");
    fireEvent.click(screen.getByRole("button", { name: "下一步" }));
    expect(pane).toHaveAttribute("data-presentation-step", "detail");
    expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();
  });

  it("starts from the top of an already-scrolled task list", () => {
    const { container } = render(<StudyHarness />);
    const list = container.querySelector<HTMLElement>(".study-task-groups")!;
    list.scrollTop = 240;
    fireEvent.click(screen.getByRole("button", { name: "快速展示" }));
    expect(list.scrollTop).toBe(0);
  });

  it("keeps keyboard focus on the presentation control through start and automatic steps", async () => {
    render(<StudyHarness />);
    const start = screen.getByRole("button", { name: "快速展示" });
    start.focus();
    fireEvent.click(start);
    expect(screen.getByRole("button", { name: "暂停展示" })).toHaveFocus();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.getByRole("button", { name: "暂停展示" })).toHaveFocus();
  });

  it("pauses its countdown while the page is hidden", async () => {
    let visibility: DocumentVisibilityState = "visible";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
    const { container } = render(<StudyHarness />);
    const pane = container.querySelector<HTMLElement>("[data-design-pane]")!;
    fireEvent.click(screen.getByRole("button", { name: "快速展示" }));
    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
    expect(pane).toHaveAttribute("data-presentation-step", "list");

    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(pane).toHaveAttribute("data-presentation-step", "detail");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
});
