import { describe, expect, it } from "vitest";
import type { TaskRecord } from "@dsh-fusion/core";
import {
  applyWorkerEvent,
  gateCompletedTask,
  normalizeEvidenceValue,
  verifyEvidence,
} from "./evidence.js";

const task: TaskRecord = {
  id: "T-evidence-001",
  goal: "run tests",
  targetNodeIds: ["tencent"],
  transport: "seekfleet",
  status: "running",
  progress: 90,
  evidence: [],
  expectedEvidence: ["command"],
  createdAt: "2026-10-20T00:00:00.000Z",
  updatedAt: "2026-10-20T00:01:00.000Z",
};

describe("evidence verification", () => {
  it("does not complete a task without expected evidence", () => {
    const verdict = verifyEvidence(task, { summary: "done" });

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("MISSING_EXPECTED_EVIDENCE");
  });

  it("moves a worker completion claim into verifying", () => {
    const updated = applyWorkerEvent(task, {
      type: "status",
      status: "completed",
      progress: 100,
    });

    expect(updated.status).toBe("verifying");
  });

  it("accepts evidence with the expected kind and non-empty value", () => {
    const verdict = verifyEvidence(task, {
      summary: "tests passed",
      evidence: [
        {
          kind: "command",
          label: "pnpm test",
          value: "2 files passed",
        },
      ],
    });

    expect(verdict).toMatchObject({ ok: true, missingKinds: [] });
  });

  it("counts evidence already attached to the task", () => {
    const taskWithEvidence: TaskRecord = {
      ...task,
      evidence: [{ kind: "command", label: "existing", value: "passed" }],
    };

    expect(verifyEvidence(taskWithEvidence, { summary: "done" }).ok).toBe(true);
  });

  it("gates a completed task without evidence back to verifying", () => {
    const completed: TaskRecord = {
      ...task,
      status: "completed",
      progress: 100,
    };

    const gated = gateCompletedTask(completed);

    expect(gated.status).toBe("verifying");
    expect(gated.updatedAt).not.toBe(completed.updatedAt);
    expect(completed.status).toBe("completed");
  });

  it("keeps a completed task when its attached evidence satisfies the gate", () => {
    const completed: TaskRecord = {
      ...task,
      status: "completed",
      progress: 100,
      evidence: [{ kind: "command", label: "pnpm test", value: "passed" }],
    };

    const gated = gateCompletedTask(completed);

    expect(gated).toEqual(completed);
  });

  it("leaves non-completed tasks untouched", () => {
    const gated = gateCompletedTask(task);

    expect(gated).toEqual(task);
  });

  it("normalizes whitespace-only evidence values for display", () => {
    expect(normalizeEvidenceValue(" \t\n ")).toBe("(empty)");
  });
});

function executionTask(id = task.id): TaskRecord {
  return {
    ...task,
    id,
    transport: "ssh",
    status: "completed",
    expectedEvidence: ["summary", "command", "log"],
    evidence: [
      { kind: "summary", label: `${id}:summary`, value: `status=completed\nexit=0\ntaskId=${id}` },
      { kind: "command", label: `${id}:stdout`, value: "(empty)" },
      { kind: "log", label: `${id}:stderr`, value: "(empty)" },
    ],
  };
}

describe("current execution evidence", () => {
  it("does not count a display placeholder as command evidence without a completion receipt", () => {
    expect(verifyEvidence(task, {
      summary: "done",
      evidence: [{ kind: "command", label: "probe", value: " (empty) " }],
    })).toMatchObject({ ok: false, reason: "MISSING_EXPECTED_EVIDENCE", missingKinds: ["command"] });
  });

  it("lets a new empty value invalidate the previous evidence at the same label", () => {
    const existing: TaskRecord = {
      ...task,
      evidence: [{ kind: "command", label: "probe", value: "old result" }],
    };
    expect(verifyEvidence(existing, {
      summary: "done",
      evidence: [{ kind: "command", label: "probe", value: " " }],
    }).ok).toBe(false);
  });

  it("keeps separately labelled evidence when another label is empty", () => {
    const existing: TaskRecord = {
      ...task,
      evidence: [{ kind: "command", label: "probe", value: "current result" }],
    };
    expect(verifyEvidence(existing, {
      summary: "done",
      evidence: [{ kind: "command", label: "another probe", value: " " }],
    }).ok).toBe(true);
  });

  it.each([
    ["running", "status=running\nexit=pending"],
    ["nonzero exit", "status=completed\nexit=1"],
    ["missing exit", "status=completed"],
    ["duplicate status", "status=running\nstatus=completed\nexit=0"],
    ["duplicate exit", "status=completed\nexit=1\nexit=0"],
    ["foreign task", "status=completed\nexit=0\ntaskId=another-task"],
  ])("rejects a %s receipt even with nonempty stdout and stderr", (_name, value) => {
    const completed = executionTask();
    completed.evidence[0]!.value = value;
    completed.evidence[1]!.value = "stdout";
    completed.evidence[2]!.value = "stderr";
    expect(gateCompletedTask(completed).status).toBe("verifying");
  });

  it("does not replay another task's receipt and output", () => {
    const completed = { ...executionTask("previous-task"), id: task.id };
    expect(gateCompletedTask(completed).status).toBe("verifying");
  });

  it("accepts a successful task-bound receipt with genuinely empty streams", () => {
    const completed = executionTask();
    expect(gateCompletedTask(completed)).toEqual(completed);
  });

  it("accepts a refreshed completion receipt in place of an earlier running receipt", () => {
    const completed = executionTask();
    const existing: TaskRecord = {
      ...completed,
      status: "verifying",
      evidence: [{ ...completed.evidence[0]!, value: "status=running\nexit=pending" }],
    };
    expect(verifyEvidence(existing, { evidence: completed.evidence }).ok).toBe(true);
  });

  it("requires the aggregate receipt to match both its child task and node", () => {
    const child = executionTask("child-1");
    const aggregate: TaskRecord = {
      ...child,
      id: "fleet-1",
      childTaskRefs: [{ id: child.id, targetNodeIds: ["tencent"], status: "completed" }],
      evidence: child.evidence.map(item => ({ ...item, label: `[tencent] ${item.label}` })),
    };
    expect(gateCompletedTask(aggregate)).toEqual(aggregate);
    const wrongNode: TaskRecord = {
      ...aggregate,
      evidence: aggregate.evidence.map(item => ({ ...item, label: item.label.replace("[tencent]", "[other-node]") })),
    };
    expect(gateCompletedTask(wrongNode).status).toBe("verifying");
  });

  it("still checks receipts when expectedEvidence is absent", () => {
    const completed = executionTask();
    delete completed.expectedEvidence;
    completed.evidence[0]!.value = "status=running\nexit=pending";
    completed.evidence[1]!.value = "stdout";
    completed.evidence[2]!.value = "stderr";
    expect(gateCompletedTask(completed).status).toBe("verifying");
  });

  it("accepts the Huawei receipt shape without an explicit taskId field", () => {
    const completed = executionTask();
    completed.evidence[0]!.value = "status=completed\r\nexit=0\r\nstdoutTruncated=false\r\nstderrTruncated=false";
    expect(gateCompletedTask(completed)).toEqual(completed);
  });

  it("lets a running receipt invalidate an older successful receipt", () => {
    const existing = executionTask();
    expect(verifyEvidence(existing, {
      summary: "done",
      evidence: [{ ...existing.evidence[0]!, value: "status=running\nexit=pending" }],
    }).ok).toBe(false);
  });
});

function aggregateExecutionTask(): TaskRecord {
  const children = ["child-a", "child-b"].map((id, index) => ({
    ...executionTask(id),
    targetNodeIds: [`node-${index}`],
  }));
  return {
    ...executionTask("fleet-multi"),
    transport: "dsh-fleet",
    targetNodeIds: children.flatMap(child => child.targetNodeIds),
    childTaskRefs: children.map(child => ({
      id: child.id,
      targetNodeIds: [...child.targetNodeIds],
      status: child.status,
    })),
    evidence: children.flatMap(child => child.evidence.map(item => ({
      ...item,
      label: `[${child.targetNodeIds[0]}] ${item.label}`,
    }))),
  };
}

describe("aggregate execution evidence", () => {
  it("accepts complete receipts and empty streams independently for both children", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.evidence[0]!.value = "status=completed\nexit=0";
    expect(gateCompletedTask(aggregate)).toEqual(aggregate);
  });

  it.each([
    [0, "summary"], [0, "command"], [0, "log"],
    [1, "summary"], [1, "command"], [1, "log"],
  ] as const)("does not let siblings replace child %i's missing %s", (index, kind) => {
    const aggregate = aggregateExecutionTask();
    const labelPrefix = `[node-${index}] child-${index === 0 ? "a" : "b"}:`;
    aggregate.evidence = aggregate.evidence.filter(item =>
      !(item.kind === kind && item.label.startsWith(labelPrefix))
    );
    const verdict = verifyEvidence(aggregate, { evidence: aggregate.evidence });
    expect(verdict).toMatchObject({
      ok: false, reason: "MISSING_EXPECTED_EVIDENCE",
      missingKinds: expect.arrayContaining([kind]),
    });
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it.each([
    "status=running\nexit=pending",
    "status=completed\nexit=1",
    "status=completed",
    "status=completed\nexit=0\ntaskId=child-a",
    "status=completed\nexit=0\nexit=1",
  ])("rejects a bad child receipt despite a complete sibling: %s", value => {
    const aggregate = aggregateExecutionTask();
    aggregate.evidence[3]!.value = value;
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("does not let a parent receipt substitute for a child with no evidence", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.evidence = [
      ...aggregate.evidence.slice(0, 3),
      ...executionTask(aggregate.id).evidence,
    ];
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("requires each child's node prefix as well as its task id", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.evidence = aggregate.evidence.map(item => ({
      ...item, label: item.label.replace("[node-1]", "[node-0]"),
    }));
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("rejects a non-completed child even when its old success receipt remains", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.childTaskRefs![1]!.status = "running";
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("checks every child even without expectedEvidence", () => {
    const aggregate = aggregateExecutionTask();
    delete aggregate.expectedEvidence;
    aggregate.evidence.pop();
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("does not reuse the old child stream after an empty refresh", () => {
    const aggregate = aggregateExecutionTask();
    expect(verifyEvidence(aggregate, {
      summary: "done",
      evidence: [{ kind: "log", label: "[node-1] child-b:stderr", value: " " }],
    }).ok).toBe(false);
  });

  it("accepts a new complete child receipt and streams in the same submission", () => {
    const aggregate = aggregateExecutionTask();
    const refreshed = aggregate.evidence.slice(3);
    aggregate.evidence = aggregate.evidence.slice(0, 3);
    expect(verifyEvidence(aggregate, { evidence: refreshed }).ok).toBe(true);
  });

  it("rejects a child with no target node", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.childTaskRefs![1]!.targetNodeIds = [];
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("requires evidence for every declared node of a child", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.childTaskRefs![1]!.targetNodeIds.push("node-missing");
    expect(gateCompletedTask(aggregate).status).toBe("verifying");
  });

  it("does not apply the success receipt gate to a cancelled aggregate", () => {
    const aggregate = aggregateExecutionTask();
    aggregate.status = "cancelled";
    aggregate.childTaskRefs![1]!.status = "cancelled";
    aggregate.evidence = [];
    expect(gateCompletedTask(aggregate)).toEqual(aggregate);
  });
});
