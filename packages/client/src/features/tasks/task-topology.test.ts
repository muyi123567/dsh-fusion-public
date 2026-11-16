import { describe, expect, it } from "vitest";
import type { NodeRecord, TaskRecord } from "@dsh-fusion/core";
import { buildTaskTopology } from "./task-topology.js";

const node: NodeRecord = {
  id: "node-1",
  externalId: "external-1",
  providerId: "ssh",
  name: "Worker A",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
  capabilities: [],
  configState: "current",
};

const task: TaskRecord = {
  id: "task-1",
  goal: "run smoke",
  targetNodeIds: ["node-1"],
  transport: "ssh",
  status: "running",
  evidence: [{ kind: "log" as const, label: "job:stderr", value: "ok" }],
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

describe("buildTaskTopology", () => {
  it("normalizes owners, tasks, nodes and evidence into one graph", () => {
    const topology = buildTaskTopology([task], [node]);

    expect(topology.version).toBe(1);
    expect(topology.ownerIds).toEqual(["owner:operator"]);
    expect(topology.taskIds).toEqual(["task-1"]);
    expect(topology.nodeIds).toEqual(["node:node-1"]);
    expect(topology.evidenceGroupIds).toEqual(["evidence:stderr"]);
    expect(topology.edges).toEqual([
      { id: "owner:operator->task:task-1", source: "owner:operator", target: "task:task-1", relation: "owns" },
      { id: "task:task-1->node:node-1", source: "task:task-1", target: "node:node-1", relation: "executes_on" },
      { id: "task:task-1->evidence:stderr", source: "task:task-1", target: "evidence:stderr", relation: "produces" },
    ]);
    expect(topology.entities.find((entity) => entity.kind === "node")?.taskIds).toEqual(["task-1"]);
  });

  it("keeps unassigned targets visible instead of dropping them", () => {
    const topology = buildTaskTopology([{ ...task, targetNodeIds: [] }], []);
    expect(topology.nodeIds).toEqual(["node:unassigned"]);
    expect(topology.entities.find((entity) => entity.id === "node:unassigned")?.label).toBe("未分配节点");
  });

  it("merges repeated owners, nodes and evidence groups without duplicate entities", () => {
    const topology = buildTaskTopology([task, { ...task, id: "task-2" }], [node]);
    expect(topology.ownerIds).toEqual(["owner:operator"]);
    expect(topology.nodeIds).toEqual(["node:node-1"]);
    expect(topology.evidenceGroupIds).toEqual(["evidence:stderr"]);
    expect(topology.entities.filter((entity) => entity.kind === "owner").at(0)?.taskIds).toEqual(["task-1", "task-2"]);
    expect(topology.entities.filter((entity) => entity.kind === "node").at(0)?.taskIds).toEqual(["task-1", "task-2"]);
    expect(topology.entities.filter((entity) => entity.kind === "evidence").at(0)?.taskIds).toEqual(["task-1", "task-2"]);
  });
});
