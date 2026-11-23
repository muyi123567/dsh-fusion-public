import { describe, expect, it, vi } from "vitest";
import { formatFleetNotification } from "./fleet-notifications.js";

describe("fleet notifications", () => {
  it("formats a pending approval without leaking a token", () => {
    const text = formatFleetNotification({
      type: "created", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "pending",
    });
    expect(text).toContain("待审批派发");
    expect(text).toContain("Chief");
    expect(text).toContain("verify");
    expect(text).toContain("worker-a");
    expect(text).not.toMatch(/Bearer|token|sourceToken/iu);
  });

  it("formats approval and failure with the attempt/error", () => {
    expect(formatFleetNotification({
      type: "approved", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "approved", attemptId: "attempt-1",
    })).toContain("attempt-1");
    expect(formatFleetNotification({
      type: "failed", requestId: "req-1", taskId: "task-1", jobId: "verify",
      nodeId: "worker-a", requestedBy: "Chief", status: "failed", error: "environment-drift",
    })).toContain("environment-drift");
  });
});
