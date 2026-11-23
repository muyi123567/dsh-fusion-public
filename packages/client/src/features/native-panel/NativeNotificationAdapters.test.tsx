import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeNotificationAdapters } from "./NativeNotificationAdapters.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("lists adapters, shows the last receipt, and tests one adapter", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      catalog: [{ kind: "slack" }],
      adapters: [{ id: "ops", kind: "slack", label: "Ops Slack", enabled: true, state: "configured" }],
      receipts: [{ adapterId: "ops", status: "delivered" }],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      receipts: [{ adapterId: "ops", status: "delivered" }],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      catalog: [{ kind: "slack" }],
      adapters: [{ id: "ops", kind: "slack", label: "Ops Slack", enabled: true, state: "configured" }],
      receipts: [{ adapterId: "ops", status: "delivered" }],
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  render(<NativeNotificationAdapters />);
  expect(await screen.findByText(/通知适配器 · 1/u)).toBeVisible();
  expect(screen.getByText(/最近 delivered/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "测试" }));
  await waitFor(() => expect(screen.getByText("测试结果：delivered")).toBeVisible());
  expect(fetcher.mock.calls[1]?.[0]).toContain("/notifications/test");
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ adapterId: "ops" });
});
