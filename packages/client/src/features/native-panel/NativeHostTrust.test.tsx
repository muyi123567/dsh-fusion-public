import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeHostTrust } from "./NativeHostTrust.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("trusts a host with an available key and can revoke it", async () => {
  const user = userEvent.setup();
  const host = {
    hostId: `sha256:${"a".repeat(64)}`, displayName: "worker-b", trust: "untrusted",
    verified: false, trusted: false, candidateKeyAvailable: true,
  };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ mode: "manual", entries: [], hosts: [host] }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ hostId: host.hostId, source: "manual" }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      mode: "manual", entries: [{ hostId: host.hostId }],
      hosts: [{ ...host, trust: "verified", verified: true, trusted: true }],
    }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ revoked: true }), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ mode: "manual", entries: [], hosts: [host] }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  render(<NativeHostTrust />);
  expect(await screen.findByText(/主机信任 · 1/u)).toBeVisible();
  await user.click(screen.getByRole("button", { name: "信任" }));
  await waitFor(() => expect(screen.getByText("已信任该主机。")).toBeVisible());
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ hostId: host.hostId });

  await user.click(await screen.findByRole("button", { name: "撤销" }));
  await waitFor(() => expect(screen.getByText("已撤销信任。")).toBeVisible());
  expect(fetcher.mock.calls[3]?.[0]).toContain("/trust/revoke");
});
