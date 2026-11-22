import { createEvent, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkbenchPreview } from "./WorkbenchPreview.js";

const habitat = vi.hoisted(() => ({ fail: false }));
const ignoreSyntheticRenderError = (event: ErrorEvent) => {
  if (event.error instanceof Error && event.error.message === "Synthetic ocean module render failure") event.preventDefault();
};
vi.mock("../whale/ambient/WhaleHabitat.js", () => ({
  WhaleHabitat: () => {
    if (habitat.fail) throw new Error("Synthetic ocean module render failure");
    return <div aria-label="已加载的合成海域" />;
  },
}));

beforeEach(() => {
  window.history.replaceState(null, "", "/workbench-preview.html?concept=focus");
  habitat.fail = false;
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => window.setTimeout(() => callback(0), 0));
});
afterEach(() => { window.removeEventListener("error", ignoreSyntheticRenderError); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function openEvidence() {
  const user = userEvent.setup();
  render(<WorkbenchPreview />);
  await user.click(screen.getByRole("button", { name: /复核原生面板交互/ }));
  const evidenceTab = screen.getByRole("tab", { name: /证据/ });
  await user.click(evidenceTab);
  return { user, evidenceTab };
}

it("keeps task inspection available when the optional ocean module throws and permits a local retry", async () => {
  const user = userEvent.setup();
  vi.spyOn(console, "error").mockImplementation(() => {});
  window.addEventListener("error", ignoreSyntheticRenderError);
  render(<WorkbenchPreview />);
  habitat.fail = true;
  await user.click(screen.getByRole("button", { name: "打开海域" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("海域");
  expect(screen.getByRole("button", { name: /复核原生面板交互/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /核对运行环境与配置/ }));
  expect(within(screen.getByRole("region", { name: "合成任务详情" })).getByRole("heading", { name: "核对运行环境与配置" })).toBeInTheDocument();
  habitat.fail = false;
  await user.click(screen.getByRole("button", { name: "重试海域" }));
  await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
  expect(within(screen.getByRole("region", { name: "合成任务详情" })).getByRole("heading", { name: "核对运行环境与配置" })).toBeInTheDocument();
});

it("preserves a mobile Chinese draft and its focus when Escape cancels IME composition", async () => {
  const { user, evidenceTab } = await openEvidence();
  await user.click(screen.getByRole("button", { name: /本地聊天草稿/ }));
  const draft = screen.getByRole("textbox", { name: "窄屏本地聊天草稿" });
  await user.click(draft);
  fireEvent.change(draft, { target: { value: "中文草稿仍在输入" } });
  fireEvent.keyDown(draft, { key: "Escape", isComposing: true });
  await waitFor(() => expect(draft).toHaveFocus());
  expect(draft).toHaveValue("中文草稿仍在输入");
  expect(evidenceTab).toHaveAttribute("aria-selected", "true");
});

it.each(["composing", "prevented"] as const)("ignores an Escape event already owned by %s inside the detail", async kind => {
  const { evidenceTab } = await openEvidence();
  const event = createEvent.keyDown(evidenceTab, { key: "Escape", cancelable: true, isComposing: kind === "composing" });
  if (kind === "prevented") event.preventDefault();
  fireEvent(evidenceTab, event);
  expect(evidenceTab).toHaveAttribute("aria-selected", "true");
});

it.each(["input", "textarea", "contenteditable"] as const)("does not consume Escape from a detail %s editor", async kind => {
  const { evidenceTab } = await openEvidence();
  const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
  if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
  screen.getByRole("region", { name: "合成任务详情" }).append(editor);
  fireEvent.keyDown(editor, { key: "Escape" });
  expect(evidenceTab).toHaveAttribute("aria-selected", "true");
});

it("does not navigate task details when Escape belongs to the surrounding preview controls", async () => {
  const { evidenceTab } = await openEvidence();
  fireEvent.keyDown(screen.getByRole("button", { name: "切换浅色主题" }), { key: "Escape" });
  expect(evidenceTab).toHaveAttribute("aria-selected", "true");
});

it("returns a focused mobile detail to its task row on an unclaimed Escape", async () => {
  const { evidenceTab } = await openEvidence();
  evidenceTab.focus();
  fireEvent.keyDown(evidenceTab, { key: "Escape" });
  await waitFor(() => expect(screen.getByRole("button", { name: /复核原生面板交互/ })).toHaveFocus());
  expect(screen.getByRole("tab", { name: "概览" })).toHaveAttribute("aria-selected", "true");
});
