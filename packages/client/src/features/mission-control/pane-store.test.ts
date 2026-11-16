import { beforeEach, describe, expect, it } from "vitest";
import { loadPanes, persistPanes } from "./pane-store.js";

describe("mission control pane store", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("restores panes and row assignments from storage", () => {
    persistPanes(["s1", "s2"], { s1: 0, s2: 1 });

    expect(loadPanes()).toEqual({
      panes: ["s1", "s2"],
      rows: { s1: 0, s2: 1 },
    });
  });
});
