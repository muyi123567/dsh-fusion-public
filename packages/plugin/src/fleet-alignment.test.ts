import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AlignmentError,
  createFleetAlignmentService,
  type AlignmentBundle,
  type AlignmentPluginManager,
} from "./fleet-alignment.js";
import type { FleetHostManifest } from "./fleet-environment.js";
import type { FleetPlanReport, FleetPlanStep } from "./fleet-plan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const LOCAL = `sha256:${"a".repeat(64)}`;
const SHA = `sha256:${"b".repeat(64)}`;

function manifest(hostId = LOCAL): FleetHostManifest {
  return {
    contractVersion: 1, hostId, displayName: "host", observedAt: "2026-11-24T06:00:00.000Z",
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "arm64" },
    bundles: [], patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
    providers: [], mcpServers: [], secrets: { present: [] }, environmentDigest: SHA,
    signature: { alg: "ed25519", keyId: "host:test", value: `${"A".repeat(86)}==` },
  };
}

function step(overrides: Partial<FleetPlanStep> & Pick<FleetPlanStep, "id" | "action" | "target">): FleetPlanStep {
  return {
    risk: "medium", requiresRestart: true, reason: "test", ...overrides,
  };
}

function planReport(steps: FleetPlanStep[]): FleetPlanReport {
  return {
    contractVersion: 1, hostId: LOCAL, expectedDigest: SHA, observedDigest: SHA,
    overall: steps.length === 0 ? "ready" : "plan", steps,
  };
}

function manager(initial: AlignmentBundle[]) {
  const bundles = new Map(initial.map(bundle => [bundle.name, { ...bundle }]));
  const installBundle = vi.fn(async (spec: string, options?: Record<string, unknown>) => {
    const [name, version] = spec.split("@");
    bundles.set(name!, {
      name: name!,
      enabled: options?.enabled !== false,
      ...(version === undefined ? {} : { version }),
    });
  });
  return {
    bundles,
    installBundle,
    setBundleEnabled: vi.fn(async (name: string, enabled: boolean) => {
      const bundle = bundles.get(name);
      if (bundle === undefined) throw new Error(`missing bundle: ${name}`);
      bundle.enabled = enabled;
    }),
    listBundles: async () => [...bundles.values()].map(bundle => ({ ...bundle })),
  } satisfies AlignmentPluginManager & { bundles: Map<string, AlignmentBundle>; installBundle: ReturnType<typeof vi.fn> };
}

function service(options: {
  plan: FleetPlanReport;
  manager?: ReturnType<typeof manager>;
  refreshImpl?: () => Promise<void>;
}) {
  const path = join(mkdtempSync(join(tmpdir(), "fleet-alignment-")), "alignment.json");
  roots.push(path);
  let match = false;
  const fleet = {
    manifest: async () => manifest(),
    plan: async () => options.plan,
    diff: async () => ({
      contractVersion: 1 as const, hostId: LOCAL, expectedDigest: SHA, observedDigest: SHA,
      checkedAt: "2026-11-24T06:00:00.000Z",
      overall: match ? "match" as const : "drift" as const,
      items: match ? [] : [{ code: "bundle.missing" as const, severity: "block" as const, path: "bundles[x]" }],
    }),
    refresh: async () => {
      await options.refreshImpl?.();
      match = true;
      return manifest();
    },
  };
  return {
    service: createFleetAlignmentService({
      path, fleet, manager: () => options.manager,
      now: () => Date.parse("2026-11-24T06:00:00Z"),
    }),
    path,
  };
}

describe("fleet alignment execution", () => {
  it("plans auto and manual steps without executing them", async () => {
    const mgr = manager([{ name: "existing", version: "1.0.0", enabled: false }]);
    const { service: alignment } = service({
      manager: mgr,
      plan: planReport([
        step({ id: "enable:existing", action: "enable", target: "existing" }),
        step({ id: "install:new", action: "install", target: "new", spec: "new@2.0.0", expectedVersion: "2.0.0" }),
        step({ id: "review:patch", action: "review", target: "patch" }),
      ]),
    });
    const planned = await alignment.plan(LOCAL);
    expect(planned.steps).toMatchObject([
      { action: "enable", exec: "auto" },
      { action: "install", exec: "auto", spec: "new@2.0.0" },
      { action: "review", exec: "manual" },
    ]);
    expect(mgr.setBundleEnabled).not.toHaveBeenCalled();
    expect(mgr.installBundle).not.toHaveBeenCalled();
  });

  it("creates, persists, approves and verifies an enable step", async () => {
    const mgr = manager([{ name: "existing", version: "1.0.0", enabled: false }]);
    const { service: alignment, path } = service({
      manager: mgr,
      plan: planReport([step({ id: "enable:existing", action: "enable", target: "existing" })]),
    });
    const request = await alignment.create({ hostId: LOCAL, requestedBy: "Chief", source: "test" });
    expect(request.status).toBe("pending");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(alignment.list()).toHaveLength(1);

    const approved = await alignment.approve(request.id, "human");
    expect(approved).toMatchObject({
      status: "succeeded",
      approvedBy: "human",
      results: [{ stepId: "enable:existing", status: "executed" }],
      after: { overall: "match" },
    });
    expect(mgr.bundles.get("existing")?.enabled).toBe(true);
  });

  it("installs with an exact expected version and saves exact", async () => {
    const mgr = manager([]);
    const { service: alignment } = service({
      manager: mgr,
      plan: planReport([step({ id: "install:new", action: "install", target: "new", spec: "new@2.0.0", expectedVersion: "2.0.0" })]),
    });
    const request = await alignment.create({ hostId: LOCAL, requestedBy: "Chief", source: "test" });
    const approved = await alignment.approve(request.id, "human");
    expect(approved.status).toBe("succeeded");
    expect(mgr.installBundle).toHaveBeenCalledWith("new@2.0.0", {
      enabled: true,
      saveExact: true,
      expected: { name: "new", version: "2.0.0" },
    });
  });

  it("rejects a plan that changed after approval was requested", async () => {
    const mgr = manager([{ name: "existing", version: "1.0.0", enabled: false }]);
    const plan = planReport([step({ id: "enable:existing", action: "enable", target: "existing" })]);
    const { service: alignment } = service({ manager: mgr, plan });
    const request = await alignment.create({ hostId: LOCAL, requestedBy: "Chief", source: "test" });
    plan.steps.push(step({ id: "install:new", action: "install", target: "new", spec: "new@2.0.0" }));
    await expect(alignment.approve(request.id, "human")).rejects.toMatchObject({ code: "alignment/plan-changed" });
  });

  it("rolls back executed enable steps when a later install fails", async () => {
    const mgr = manager([{ name: "existing", version: "1.0.0", enabled: false }]);
    mgr.installBundle.mockRejectedValueOnce(new Error("network down"));
    const { service: alignment } = service({
      manager: mgr,
      plan: planReport([
        step({ id: "enable:existing", action: "enable", target: "existing" }),
        step({ id: "install:new", action: "install", target: "new", spec: "new@2.0.0", expectedVersion: "2.0.0" }),
      ]),
    });
    const request = await alignment.create({ hostId: LOCAL, requestedBy: "Chief", source: "test" });
    const approved = await alignment.approve(request.id, "human");
    expect(approved.status).toBe("failed");
    expect(approved.rollback).toEqual([
      expect.objectContaining({ stepId: "enable:existing", status: "rolled-back" }),
    ]);
    expect(mgr.bundles.get("existing")?.enabled).toBe(false);
  });

  it("stops at manual-required when the plan has no auto steps", async () => {
    const mgr = manager([]);
    const { service: alignment } = service({
      manager: mgr,
      plan: planReport([step({ id: "review:patch", action: "review", target: "patch" })]),
    });
    const request = await alignment.create({ hostId: LOCAL, requestedBy: "Chief", source: "test" });
    const approved = await alignment.approve(request.id, "human");
    expect(approved.status).toBe("manual-required");
    expect(approved.results).toEqual([expect.objectContaining({ status: "manual" })]);
  });

  it("rejects remote hosts, cancels pending requests, and reloads history", async () => {
    const mgr = manager([]);
    const { service: alignment, path } = service({ manager: mgr, plan: planReport([]) });
    await expect(alignment.create({ hostId: `sha256:${"c".repeat(64)}`, requestedBy: "Chief", source: "test" }))
      .rejects.toBeInstanceOf(AlignmentError);

    const plan = planReport([step({ id: "review:patch", action: "review", target: "patch" })]);
    const created = await alignment.create({ hostId: LOCAL, requestedBy: "Chief", source: "test" });
    expect((await alignment.cancel(created.id)).status).toBe("cancelled");
    await expect(alignment.approve(created.id, "human")).rejects.toMatchObject({ code: "alignment/state" });

    const reloaded = createFleetAlignmentService({
      path,
      fleet: {
        manifest: async () => manifest(),
        plan: async () => plan,
        diff: async () => ({
          contractVersion: 1, hostId: LOCAL, expectedDigest: SHA, observedDigest: SHA,
          checkedAt: "2026-11-24T06:00:00.000Z", overall: "match", items: [],
        }),
      },
      manager: () => mgr,
    });
    expect(reloaded.list()).toHaveLength(1);
  });
});
