import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeQuickstart } from "./NativeQuickstart.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("walks through expected, skill and backup onboarding once", async () => {
  const user = userEvent.setup();
  const hostId = `sha256:${"a".repeat(64)}`;
  const status = (overall: string, backups: number) => ({
    host: { hostId, overall, verified: true },
    systems: { backups: { count: backups } },
  });
  const presets = (state: string) => ({
    presets: [{ id: "whale-fleet-ops", kind: "skill", title: "鲸群多机运维 Skill", status: { state } }],
  });
  const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
  const fetcher = vi.fn()
    .mockResolvedValueOnce(ok(status("unknown", 0)))
    .mockResolvedValueOnce(ok(presets("not-installed")))
    .mockResolvedValueOnce(ok({ hostId }))
    .mockResolvedValueOnce(ok(status("drift", 0)))
    .mockResolvedValueOnce(ok(presets("not-installed")))
    .mockResolvedValueOnce(ok({ installed: { presetId: "whale-fleet-ops" } }))
    .mockResolvedValueOnce(ok(status("drift", 0)))
    .mockResolvedValueOnce(ok(presets("installed")))
    .mockResolvedValueOnce(ok({ manifest: { id: "backup-1" } }))
    .mockResolvedValueOnce(ok(status("drift", 1)))
    .mockResolvedValueOnce(ok(presets("installed")));
  vi.stubGlobal("fetch", fetcher);

  render(<NativeQuickstart />);
  expect(await screen.findByText(/快速开始 · 3 项待完成/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "保存期望" }));
  await waitFor(() => expect(screen.getByText("已保存当前环境为期望。")).toBeVisible());
  await user.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() => expect(screen.getByText("已安装鲸群 Skill。")).toBeVisible());
  await user.click(screen.getByRole("button", { name: "创建快照" }));
  await waitFor(() => expect(screen.getByText("已创建配置快照。")).toBeVisible());
  expect(screen.getByText(/快速开始 · 已完成/u)).toBeVisible();

  expect(fetcher.mock.calls[2]?.[0]).toContain("/fleet/expected");
  expect(JSON.parse(fetcher.mock.calls[2]?.[1].body)).toEqual({ hostId });
  expect(fetcher.mock.calls[5]?.[0]).toContain("/presets/skills/install");
  expect(fetcher.mock.calls[8]?.[0]).toContain("/backups/create");
});
