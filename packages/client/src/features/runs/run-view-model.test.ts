import { describe, expect, it } from "vitest";
import type { DagRunViewInput } from "./run-view-model.js";
import { buildDependencyWaves, buildRunView } from "./run-view-model.js";

const run: DagRunViewInput = {
  id: "run-1",
  specId: "release",
  status: "completed",
  order: [["plan"], ["build"], ["review"]],
  nodes: {
    plan: { nodeId: "plan", status: "completed" },
    build: { nodeId: "build", status: "completed" },
    review: { nodeId: "review", status: "completed" },
  },
  startedAt: "2026-10-20T00:00:00.000Z",
  finishedAt: "2026-10-20T00:03:00.000Z",
};

describe("buildRunView", () => {
  it("places nodes into dependency waves", () => {
    const view = buildRunView(run);

    expect(view.find((node) => node.id === "plan")).toMatchObject({ wave: 0 });
    expect(view.find((node) => node.id === "build")).toMatchObject({ wave: 1 });
    expect(view.find((node) => node.id === "review")).toMatchObject({ wave: 2 });
  });

  it("derives waves from real task dependencies and keeps cycles visible", () => {
    expect(buildDependencyWaves([
      { id: "review", dependsOnTaskIds: ["build"] },
      { id: "build", dependsOnTaskIds: ["plan"] },
      { id: "plan" },
      { id: "parallel" },
    ])).toEqual([
      ["parallel", "plan"],
      ["build"],
      ["review"],
    ]);

    expect(buildDependencyWaves([
      { id: "a", dependsOnTaskIds: ["b"] },
      { id: "b", dependsOnTaskIds: ["a"] },
    ])).toEqual([["a", "b"]]);
  });
});
