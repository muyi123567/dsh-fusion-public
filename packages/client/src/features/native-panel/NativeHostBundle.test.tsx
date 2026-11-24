import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { NativeHostBundle } from "./NativeHostBundle.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("exports a bundle and imports a selected file with trust and expected flags", async () => {
  const user = userEvent.setup();
  const createObjectURL = vi.fn(() => "blob:bundle");
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, "createObjectURL", { value: createObjectURL, configurable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: revokeObjectURL, configurable: true });
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  const bundle = {
    contractVersion: 1,
    manifest: { hostId: `sha256:${"a".repeat(64)}` },
    publicKeyPem: "-----BEGIN PUBLIC KEY-----",
    digest: `sha256:${"b".repeat(64)}`,
  };
  const fetcher = vi.fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(bundle), { status: 200 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({
      hostId: bundle.manifest.hostId, digest: bundle.digest, trusted: true,
      expectedPath: "/tmp/expected-manifest.json",
    }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);

  render(<NativeHostBundle />);
  await user.click(screen.getByRole("button", { name: "导出" }));
  await waitFor(() => expect(screen.getByText(/已导出加入包/u)).toBeVisible());
  expect(createObjectURL).toHaveBeenCalled();
  expect(anchorClick).toHaveBeenCalled();

  const file = new File([JSON.stringify(bundle)], "bundle.json", { type: "application/json" });
  await user.upload(screen.getByLabelText("导入加入包"), file);
  await waitFor(() => expect(screen.getByText(/信任 已固定 · 已设期望/u)).toBeVisible());
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toMatchObject({
    pinTrust: true, saveExpected: true, bundle: { digest: bundle.digest },
  });
});
