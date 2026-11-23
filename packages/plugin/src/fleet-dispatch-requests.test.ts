import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createFleetDispatchRequests, DispatchRequestError } from "./fleet-dispatch-requests.js";

const digest = `sha256:${"a".repeat(64)}`;
const sourceToken = "b".repeat(64);

function service(options: { fail?: boolean; now?: () => number } = {}) {
  const dispatch = vi.fn(async () => {
    if (options.fail) throw Object.assign(new Error("denied"), { code: "environment-drift" });
    return { id: "attempt-1" };
  });
  const requests = createFleetDispatchRequests({
    path: join(mkdtempSync(join(tmpdir(), "fleet-dispatch-")), "requests.json"),
    dispatch,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const input = {
    taskId: "dsh-native-team:team:task", sourceToken, jobId: "verify", nodeId: "worker-a",
    environment: { hostId: digest, requireDigest: digest, policy: "exact" as const },
    requestedBy: "Chief", source: "mcp:ds-bot",
  };
  return { requests, dispatch, input };
}

describe("fleet dispatch requests", () => {
  it("stores a pending request, lists it, and approves it into one dispatch", async () => {
    const { requests, dispatch, input } = service();
    const created = await requests.create({ ...input, requestId: "req-1" });
    expect(created.created).toBe(true);
    expect(created.request).toMatchObject({ status: "pending", requestedBy: "Chief", source: "mcp:ds-bot" });
    expect((await requests.list()).map(row => row.id)).toEqual([created.request.id]);
    const approved = await requests.approve(created.request.id, "operator");
    expect(approved.request).toMatchObject({ status: "approved", attemptId: "attempt-1", decidedBy: "operator" });
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({
      taskId: input.taskId, jobId: "verify", nodeId: "worker-a",
      environment: input.environment, requestId: created.request.requestId,
    }));
    await expect(requests.approve(created.request.id, "operator")).rejects.toMatchObject({ code: "request-not-pending" });
  });

  it("deduplicates the same requestId instead of dispatching twice", async () => {
    const { requests, input } = service();
    const first = await requests.create({ ...input, requestId: "req-1" });
    const second = await requests.create({ ...input, requestId: "req-1" });
    expect(second.created).toBe(false);
    expect(second.request.id).toBe(first.request.id);
  });

  it("records a failed approval when the environment gate or execution refuses", async () => {
    const { requests, input } = service({ fail: true });
    const created = await requests.create({ ...input, requestId: "req-1" });
    await expect(requests.approve(created.request.id, "operator")).rejects.toMatchObject({ code: "dispatch-failed" });
    const [row] = await requests.list();
    expect(row).toMatchObject({ status: "failed", error: "environment-drift" });
  });

  it("rejects a request and never dispatches it", async () => {
    const { requests, dispatch, input } = service();
    const created = await requests.create({ ...input, requestId: "req-1" });
    const rejected = await requests.reject(created.request.id, "not now", "operator");
    expect(rejected).toMatchObject({ status: "rejected", reason: "not now", decidedBy: "operator" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("writes no plaintext token and expires stale pending requests", async () => {
    let now = 1_000;
    const { requests, input } = service({ now: () => now });
    const created = await requests.create({ ...input, requestId: "req-1" });
    const raw = readFileSync((requests as unknown as { path: string }).path, "utf8");
    expect(raw).not.toMatch(/Bearer|authorization/iu);
    now += 25 * 60 * 60 * 1_000;
    expect(await requests.list()).toEqual([]);
    await expect(requests.approve(created.request.id, "operator")).rejects.toMatchObject({ code: "request-expired" });
  });

  it("fails closed on a malformed store", async () => {
    const { requests } = service();
    writeFileSync((requests as unknown as { path: string }).path, "{not json");
    await expect(requests.list()).rejects.toBeInstanceOf(DispatchRequestError);
  });
});
