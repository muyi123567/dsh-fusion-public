import { describe, expect, it } from "vitest";
import { fusionBrowserUrl, isDshOwnedRoute } from "./routes.js";

describe("fusionBrowserUrl", () => {
  it("makes DSH-owned plugin routes document-relative", () => {
    expect(fusionBrowserUrl("/plugins/dsh-fusion/state"))
      .toBe("plugins/dsh-fusion/state");
    expect(fusionBrowserUrl("/plugins/dsh-fusion/events"))
      .toBe("plugins/dsh-fusion/events");
  });

  it("keeps Fusion's own standalone routes absolute", () => {
    expect(fusionBrowserUrl("/api/fusion/snapshot")).toBe("/api/fusion/snapshot");
    expect(fusionBrowserUrl("/api/fusion/tasks")).toBe("/api/fusion/tasks");
  });

  it("leaves an already relative route alone", () => {
    expect(fusionBrowserUrl("plugins/dsh-fusion/state"))
      .toBe("plugins/dsh-fusion/state");
  });

  it("recognises which routes DSH owns", () => {
    expect(isDshOwnedRoute("/plugins/dsh-fusion/state")).toBe(true);
    expect(isDshOwnedRoute("/api/fusion/snapshot")).toBe(false);
  });
});
