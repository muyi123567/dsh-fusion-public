import { describe, expect, it } from "vitest";
import { createProviderStatus } from "./providers.js";

describe("provider health", () => {
  it("maps an unconfigured provider to not-configured", () => {
    expect(createProviderStatus({ configured: false })).toMatchObject({
      state: "not-configured",
    });
  });
});
