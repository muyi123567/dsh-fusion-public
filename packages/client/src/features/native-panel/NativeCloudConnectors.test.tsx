import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeCloudConnectors } from "./NativeCloudConnectors.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("browses a cloud connector and pulls one file into the imports directory", async () => {
  const user = userEvent.setup();
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({
      catalog: [{ kind: "gdrive" }],
      instances: [{ id: "gd", kind: "gdrive", label: "Google Drive", enabled: true, state: "configured" }],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      entries: [
        { name: "notes", path: "notes", kind: "folder" },
        { name: "a.txt", path: "a.txt", kind: "file", size: 3 },
      ],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      name: "a.txt", localPath: "/home/u/.dsh-fusion/fleet/imports/a.txt",
      bytes: 3, sha256: "a".repeat(64),
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  render(<NativeCloudConnectors />);
  expect(await screen.findByText(/云盘连接器 · 1/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "浏览" }));
  expect(await screen.findByText("a.txt")).toBeVisible();
  expect(screen.getByText("notes")).toBeVisible();

  await user.click(screen.getByRole("button", { name: "拉取" }));
  await waitFor(() => expect(screen.getByText(/已保存 a\.txt · 3 B · sha256 a{12}…/u)).toBeVisible());
  expect(fetcher.mock.calls[2]?.[0]).toContain("/connectors/pull");
  expect(JSON.parse(fetcher.mock.calls[2]?.[1].body)).toEqual({ id: "gd", path: "a.txt" });
});
