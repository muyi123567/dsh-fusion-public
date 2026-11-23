import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeDispatchApprovals } from "./NativeDispatchApprovals.js";

const pending = {
  id: "request-1", requestId: "req-1", taskId: "task-1", jobId: "verify", nodeId: "worker-a",
  requestedBy: "Chief", source: "mcp:chief", status: "pending",
  environment: { policy: "exact", requireDigest: `sha256:${"a".repeat(64)}` },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("lists a pending dispatch and approves it through the panel route", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [pending] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ request: pending, attemptId: "attempt-1" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  render(<NativeDispatchApprovals />);
  expect(await screen.findByText(/待审批派发 · 1/u)).toBeVisible();
  expect(screen.getByText(/Chief 请求/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "批准并执行" }));
  await waitFor(() => expect(screen.getByText("已批准并提交执行。")).toBeVisible());
  expect(fetcher.mock.calls[1]?.[0]).toContain("/dispatch-requests/approve");
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ id: "request-1" });
});

it("rejects with a reason and removes the row after refresh", async () => {
  const user = userEvent.setup();
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [pending] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ ...pending, status: "rejected" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [] }), { status: 200 })));
  render(<NativeDispatchApprovals />);
  await user.click(await screen.findByRole("button", { name: "拒绝" }));
  await waitFor(() => expect(screen.getByText("已拒绝。")).toBeVisible());
  expect(screen.queryByText(/待审批派发 · 1/u)).toBeNull();
});
