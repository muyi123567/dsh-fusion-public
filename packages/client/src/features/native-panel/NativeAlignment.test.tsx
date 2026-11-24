import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeAlignment } from "./NativeAlignment.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const hostId = `sha256:${"a".repeat(64)}`;

it("builds an alignment plan and creates a pending request", async () => {
  const user = userEvent.setup();
  const step = {
    id: "install:new", action: "install", target: "new", risk: "medium",
    reason: "install new", exec: "auto",
  };
  const pending = {
    id: "align-1", status: "pending", hostId, steps: [step],
  };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ hostId }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      hostId, planDigest: `sha256:${"b".repeat(64)}`, overall: "plan", steps: [step],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ hostId }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ request: pending }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ hostId }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ requests: [pending] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  render(<NativeAlignment />);
  expect(await screen.findByText("环境对齐")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "生成计划" }));
  expect(await screen.findByText("install · new")).toBeVisible();
  expect(screen.getByText(/可执行/u)).toBeVisible();

  await user.click(screen.getByRole("button", { name: "请求执行" }));
  await waitFor(() => expect(screen.getByText("已创建待批准请求。")).toBeVisible());
  expect(await screen.findByText(/pending · align-1/u)).toBeVisible();
  expect(JSON.parse(fetcher.mock.calls[5]?.[1].body)).toMatchObject({ hostId, requestedBy: "面板" });
});
