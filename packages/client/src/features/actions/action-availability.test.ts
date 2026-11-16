import { describe, expect, it } from "vitest";
import {
  actionBlockLabel,
  cancelActionAvailability,
  promptActionAvailability,
} from "./action-availability.js";

describe("cancelActionAvailability", () => {
  const base = { status: "running", hasHandler: true, pending: false, stale: false };

  it("allows a wired, fresh, idle cancel on an active task", () => {
    expect(cancelActionAvailability(base)).toEqual({ allowed: true });
  });

  it("blocks when no cancel handler is wired, ahead of every other reason", () => {
    expect(cancelActionAvailability({ ...base, hasHandler: false, status: "completed", stale: true }))
      .toEqual({ allowed: false, reason: "no-handler" });
  });

  it("blocks terminal tasks", () => {
    expect(cancelActionAvailability({ ...base, status: "completed" }))
      .toEqual({ allowed: false, reason: "terminal-status" });
    expect(cancelActionAvailability({ ...base, status: "cancelled" }))
      .toEqual({ allowed: false, reason: "terminal-status" });
    // failed is terminal on the server (its process is gone);
    // offering a cancel for it would promise an action that
    // cannot exist.
    expect(cancelActionAvailability({ ...base, status: "failed" }))
      .toEqual({ allowed: false, reason: "terminal-status" });
  });

  it("blocks on stale data so a cancel never acts on an outdated status", () => {
    expect(cancelActionAvailability({ ...base, stale: true }))
      .toEqual({ allowed: false, reason: "stale" });
  });

  it("blocks while a cancel for the same task is in flight", () => {
    expect(cancelActionAvailability({ ...base, pending: true }))
      .toEqual({ allowed: false, reason: "in-flight" });
  });
});

describe("promptActionAvailability", () => {
  const base = { hasSession: true, hasEndpoint: true };

  it("allows when a session and an endpoint exist", () => {
    expect(promptActionAvailability(base)).toEqual({ allowed: true });
  });

  it("blocks without a session, then without an endpoint", () => {
    expect(promptActionAvailability({ ...base, hasSession: false, hasEndpoint: false }))
      .toEqual({ allowed: false, reason: "no-session" });
    expect(promptActionAvailability({ ...base, hasEndpoint: false }))
      .toEqual({ allowed: false, reason: "no-endpoint" });
  });

  it("blocks sources that cannot take prompts and inactive agents (SessionPane inputs)", () => {
    expect(promptActionAvailability({ ...base, sourceSupported: false }))
      .toEqual({ allowed: false, reason: "unsupported-source" });
    expect(promptActionAvailability({ ...base, sourceSupported: true, agentAvailable: false }))
      .toEqual({ allowed: false, reason: "agent-unavailable" });
    expect(promptActionAvailability({ ...base, sourceSupported: true, agentAvailable: true }))
      .toEqual({ allowed: true });
  });

  it("blocks finished or errored sessions (BotWorkspace record inputs)", () => {
    expect(promptActionAvailability({ ...base, sessionStatus: "finished" }))
      .toEqual({ allowed: false, reason: "session-ended" });
    expect(promptActionAvailability({ ...base, sessionStatus: "error" }))
      .toEqual({ allowed: false, reason: "session-ended" });
    expect(promptActionAvailability({ ...base, sessionStatus: "idle" }))
      .toEqual({ allowed: true });
  });

  it("blocks on stale snapshot data", () => {
    expect(promptActionAvailability({ ...base, stale: true }))
      .toEqual({ allowed: false, reason: "stale" });
  });

  it("gives every block reason a user-facing label", () => {
    for (const reason of [
      "no-handler", "terminal-status", "in-flight", "stale",
      "no-session", "no-endpoint", "unsupported-source",
      "agent-unavailable", "session-ended",
    ] as const) {
      expect(actionBlockLabel(reason).length).toBeGreaterThan(0);
    }
  });
});
