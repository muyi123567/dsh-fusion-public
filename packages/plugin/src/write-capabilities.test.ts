import { describe, expect, it } from "vitest";
import type { FusionToolHostContext } from "./upstream-tools.js";
import {
  WRITE_CAPABILITIES_SCHEMA,
  writeCapabilitiesSnapshot,
} from "./write-capabilities.js";

const ALL_ON = { agentTeams: true, agentBus: true, room: true };
const ALL_OFF = { agentTeams: false, agentBus: false, room: false };

function fullCtx(): FusionToolHostContext {
  return {
    tools: {
      register: () => () => {},
      execute: async () => ({ isError: false, value: null }),
    },
    get: (name: string) => (name === "approval"
      ? { request: async () => "allowed-once" }
      : undefined),
  };
}

function actionStates(
  snapshot: ReturnType<typeof writeCapabilitiesSnapshot>,
  family: "agentTeams" | "agentBus" | "room",
) {
  return Object.fromEntries(
    snapshot.families[family].actions.map((action) => [action.action, action]),
  );
}

describe("writeCapabilitiesSnapshot", () => {
  it("inventories all fifteen write actions with their upstream names and approval needs", () => {
    const snapshot = writeCapabilitiesSnapshot(fullCtx(), ALL_ON, 123);
    expect(snapshot.checkedAt).toBe(123);
    const teams = actionStates(snapshot, "agentTeams");
    expect(Object.keys(teams)).toEqual([
      "fusion_team_approve",
      "fusion_team_resume",
      "fusion_team_send_message",
    ]);
    expect(teams["fusion_team_approve"]).toMatchObject({
      upstream: "agent_teams_approve",
      approvalRequired: true,
    });
    expect(teams["fusion_team_send_message"]).toMatchObject({
      upstream: "agent_teams_send_message",
      approvalRequired: false,
    });
    const bus = actionStates(snapshot, "agentBus");
    expect(Object.keys(bus)).toHaveLength(6);
    expect(Object.values(bus).every((action) => action.approvalRequired === false)).toBe(true);
    const room = actionStates(snapshot, "room");
    expect(Object.keys(room)).toHaveLength(6);
    expect(room["fusion_room_close"]).toMatchObject({
      upstream: "room_close",
      approvalRequired: true,
    });
    expect(room["fusion_room_create"]).toMatchObject({ approvalRequired: false });
  });

  it("marks every action ready when all Fusion-side prerequisites hold, with upstream existence honestly unknown", () => {
    const snapshot = writeCapabilitiesSnapshot(fullCtx(), ALL_ON, 1);
    for (const family of Object.values(snapshot.families)) {
      expect(family.upstreamExistence).toBe("unknown");
      expect(family.executeCapability).toBe(true);
      for (const action of family.actions) {
        expect(action.state).toBe("ready");
        expect(action.reasons).toEqual([]);
      }
    }
    expect(snapshot.families.agentTeams.approvalService).toBe(true);
    expect(snapshot.families.room.approvalService).toBe(true);
    // AgentBus writes have no approval step by design: null, not false.
    expect(snapshot.families.agentBus.approvalService).toBeNull();
  });

  it("reports writes-disabled per family without touching the others", () => {
    const snapshot = writeCapabilitiesSnapshot(fullCtx(), { ...ALL_ON, room: false }, 1);
    for (const action of snapshot.families.room.actions) {
      expect(action.state).toBe("unavailable");
      expect(action.reasons).toEqual(["WRITES_DISABLED"]);
    }
    for (const action of snapshot.families.agentTeams.actions) {
      expect(action.state).toBe("ready");
    }
  });

  it("distinguishes a missing execute capability from an approval outage", () => {
    const noExecute: FusionToolHostContext = {
      tools: { register: () => () => {} },
      get: (name: string) => (name === "approval"
        ? { request: async () => "allowed-once" }
        : undefined),
    };
    const snapshot = writeCapabilitiesSnapshot(noExecute, ALL_ON, 1);
    for (const family of Object.values(snapshot.families)) {
      expect(family.executeCapability).toBe(false);
      for (const action of family.actions) {
        expect(action.state).toBe("unavailable");
        expect(action.reasons).toEqual(["UPSTREAM_EXECUTE_UNAVAILABLE"]);
      }
    }

    const noApproval: FusionToolHostContext = {
      tools: {
        register: () => () => {},
        execute: async () => ({ isError: false, value: null }),
      },
      get: () => undefined,
    };
    const unapproved = writeCapabilitiesSnapshot(noApproval, ALL_ON, 1);
    const teams = actionStates(unapproved, "agentTeams");
    expect(teams["fusion_team_approve"]!.reasons).toEqual(["APPROVAL_UNAVAILABLE"]);
    expect(teams["fusion_team_send_message"]!.state).toBe("ready");
    const room = actionStates(unapproved, "room");
    expect(room["fusion_room_broadcast"]!.reasons).toEqual(["APPROVAL_UNAVAILABLE"]);
    expect(room["fusion_room_send"]!.state).toBe("ready");
    // Bus actions never gain an approval reason.
    for (const action of unapproved.families.agentBus.actions) {
      expect(action.state).toBe("ready");
    }
  });

  it("never throws on a hostile host context", () => {
    const hostile: FusionToolHostContext = {
      tools: { register: () => () => {} },
      get: () => { throw new Error("host exploded"); },
    };
    const snapshot = writeCapabilitiesSnapshot(hostile, ALL_OFF, 7);
    expect(snapshot.checkedAt).toBe(7);
    expect(snapshot.families.agentTeams.approvalService).toBe(false);
    const teams = actionStates(snapshot, "agentTeams");
    expect(teams["fusion_team_approve"]!.reasons).toEqual([
      "WRITES_DISABLED",
      "UPSTREAM_EXECUTE_UNAVAILABLE",
      "APPROVAL_UNAVAILABLE",
    ]);
  });

  it("uses the DSH single-type schema subset for nullable approval state", () => {
    expect(
      WRITE_CAPABILITIES_SCHEMA.properties.families.properties.agentTeams.properties.approvalService,
    ).toEqual({
      oneOf: [{ type: "boolean" }, { type: "null" }],
    });

    const assertSingleTypeNodes = (value: unknown): void => {
      if (value === null || typeof value !== "object") return;
      if ("type" in value) {
        expect(Array.isArray((value as { type?: unknown }).type)).toBe(false);
      }
      for (const child of Object.values(value)) assertSingleTypeNodes(child);
    };

    assertSingleTypeNodes(WRITE_CAPABILITIES_SCHEMA);
  });
});
