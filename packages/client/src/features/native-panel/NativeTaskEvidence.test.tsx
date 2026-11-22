import type { TaskRecord } from "@dsh-fusion/core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { NativeTaskEvidence } from "./NativeTaskEvidence.js";

const raw = "交接记录\r\n\r\n2 查看结果\r\n4 <img src=x>\r\n";
const digest = "a".repeat(64);
const task: TaskRecord = {
  id: "task-1", goal: "核对交接", status: "verifying", transport: "ssh",
  targetNodeIds: [], createdAt: "", updatedAt: "",
  evidence: [
    { kind: "summary", label: "交接摘要", value: raw, sha256: digest },
    { kind: "artifact", label: "产物链接", value: "https://example.com/artifact" },
    { kind: "log", label: "带凭据的日志", value: "https://reader@example.com/log" },
  ],
};

afterEach(cleanup);

it("keeps the reading layout and exactly restores raw evidence with its digest", async () => {
  const user = userEvent.setup();
  const { container } = render(<NativeTaskEvidence task={task} demo />);
  const panel = screen.getByRole("tabpanel", { name: "交接摘要" });
  expect(panel).toHaveTextContent("演示来源");
  expect(within(panel).getByRole("list")).toHaveTextContent("查看结果");
  expect(within(panel).getAllByRole("listitem").map(item => item.getAttribute("value"))).toEqual(["2", "4"]);
  expect(container.querySelector("img")).toBeNull();
  await user.click(within(panel).getByRole("button", { name: "原文" }));
  expect(panel.querySelector("pre")?.textContent).toBe(raw);
  await user.click(within(panel).getByText("SHA-256"));
  expect(within(panel).getByText(digest)).toBeVisible();
});

it("isolates keyboard evidence selection across panels and leaves IME events alone", async () => {
  const user = userEvent.setup();
  render(<><NativeTaskEvidence task={task} /><NativeTaskEvidence task={task} /></>);
  const [left, right] = screen.getAllByRole("region", { name: "来源证据" }).map(region => within(region));
  if (!left || !right) throw new Error("both panels must be present");
  const firstLeft = left.getByRole("tab", { name: "交接摘要" });
  const firstRight = right.getByRole("tab", { name: "交接摘要" });
  expect(firstLeft.id).not.toBe(firstRight.id);
  firstRight.focus();
  fireEvent.keyDown(firstRight, { key: "ArrowRight", isComposing: true });
  expect(firstRight).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(right.getByRole("tab", { name: "产物链接" })).toHaveFocus();
  expect(right.getByRole("tabpanel", { name: "产物链接" })).toBeVisible();
  expect(left.getByRole("tabpanel", { name: "交接摘要" })).toBeVisible();
  await user.keyboard("{End}");
  expect(right.getByRole("tab", { name: "带凭据的日志" })).toHaveFocus();
  await user.keyboard("{ArrowRight}");
  expect(firstRight).toHaveFocus();
});

it("navigates only to safe absolute evidence URLs and keeps unlinked source text readable", async () => {
  const user = userEvent.setup();
  render(<NativeTaskEvidence task={task} />);
  await user.click(screen.getByRole("tab", { name: "产物链接" }));
  const link = screen.getByRole("link", { name: "https://example.com/artifact" });
  expect(link).toHaveAttribute("href", "https://example.com/artifact");
  expect(link).toHaveAttribute("target", "_blank");
  expect(link).toHaveAttribute("rel", "noreferrer noopener");
  await user.click(screen.getByRole("tab", { name: "带凭据的日志" }));
  expect(screen.queryByRole("link")).toBeNull();
  expect(screen.getByText("https://reader@example.com/log")).toBeVisible();
});
