import { describe, expect, it } from "vitest";
import {
  FUSION_DEFAULT_MODEL_ROUTE,
  FUSION_DEFAULT_REASONING_EFFORT,
} from "@dsh-fusion/core";
import { createDemoSnapshot } from "./demo-store.js";

describe("demo model defaults", () => {
  it("uses the CN DeepSeek route at max effort for every seeded bot", () => {
    const snapshot = createDemoSnapshot();

    expect(snapshot.bots).not.toHaveLength(0);
    for (const bot of snapshot.bots) {
      expect(bot.model).toBe(FUSION_DEFAULT_MODEL_ROUTE);
      expect(bot.reasoningEffort).toBe(FUSION_DEFAULT_REASONING_EFFORT);
    }
  });
});
