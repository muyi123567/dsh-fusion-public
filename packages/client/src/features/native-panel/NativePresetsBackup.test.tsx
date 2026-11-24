import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativePresetsBackup } from "./NativePresetsBackup.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("installs the bundled skill and creates a config snapshot", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      presets: [
        { id: "whale-fleet-ops", kind: "skill", title: "鲸群多机运维 Skill", description: "skill", tags: ["skill"], status: { state: "not-installed" } },
        { id: "popular-companions", kind: "plugins", title: "热门 DSH 插件", description: "plugins", tags: ["plugins"], plugins: [{ name: "im", spec: "@xmanrui/dsh-im@5.10.0", why: "im" }] },
      ],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ backups: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ installed: { presetId: "whale-fleet-ops" } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      presets: [
        { id: "whale-fleet-ops", kind: "skill", title: "鲸群多机运维 Skill", description: "skill", tags: ["skill"], status: { state: "installed" } },
      ],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ backups: [] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ manifest: { id: "20261124T060000Z-aaaaaaaa" } }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      presets: [
        { id: "whale-fleet-ops", kind: "skill", title: "鲸群多机运维 Skill", description: "skill", tags: ["skill"], status: { state: "installed" } },
      ],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      backups: [{ id: "20261124T060000Z-aaaaaaaa", createdAt: "2026-11-24T06:00:00.000Z", reason: "panel", files: 3, bytes: 100 }],
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  render(<NativePresetsBackup />);
  expect(await screen.findByText(/预设与热备 · 2/u)).toBeVisible();
  expect(screen.getByText(/@xmanrui\/dsh-im@5.10.0/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "安装" }));
  await waitFor(() => expect(screen.getByText("已安装 Skill。")).toBeVisible());
  expect(JSON.parse(fetcher.mock.calls[2]?.[1].body)).toEqual({ id: "whale-fleet-ops" });

  await user.click(screen.getByRole("button", { name: "立即快照" }));
  await waitFor(() => expect(screen.getByText("已创建配置快照。")).toBeVisible());
  expect(fetcher.mock.calls[5]?.[0]).toContain("/backups/create");
});
