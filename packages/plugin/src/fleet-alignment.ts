import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  canonicalJson,
  sha256Hex,
  type FleetDriftReport,
  type FleetHostManifest,
} from "./fleet-environment.js";
import type {
  FleetPlanReport,
  FleetPlanStep,
} from "./fleet-plan.js";
import type { WhaleFleetServiceV1 } from "./fleet-service.js";

export interface AlignmentBundle {
  name: string;
  version?: string;
  enabled: boolean;
  availability?: string;
}

export interface AlignmentPluginManager {
  listBundles(): Promise<AlignmentBundle[]>;
  setBundleEnabled(name: string, enabled: boolean): Promise<unknown>;
  installBundle?(spec: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface AlignmentStepPlan extends FleetPlanStep {
  exec: "auto" | "manual";
  manualReason?: string;
}

export interface FleetAlignmentPlan {
  contractVersion: 1;
  hostId: string;
  planDigest: string;
  plan: FleetPlanReport;
  steps: AlignmentStepPlan[];
}

export interface AlignmentStepResult {
  stepId: string;
  action: string;
  target: string;
  status: "executed" | "manual" | "failed" | "rolled-back";
  detail?: string;
}

export type AlignmentStatus =
  | "pending" | "running" | "succeeded" | "partial" | "failed" | "manual-required" | "cancelled";

export interface FleetAlignmentRequest {
  contractVersion: 1;
  id: string;
  hostId: string;
  requestedBy: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  status: AlignmentStatus;
  planDigest: string;
  plan: FleetPlanReport;
  steps: AlignmentStepPlan[];
  approvedBy?: string;
  startedAt?: string;
  finishedAt?: string;
  beforeDigest?: string;
  afterDigest?: string;
  after?: FleetDriftReport;
  results?: AlignmentStepResult[];
  rollback?: AlignmentStepResult[];
  error?: string;
}

export interface WhaleAlignmentServiceV1 {
  readonly contractVersion: 1;
  plan(hostId: string, expectedDigest?: string): Promise<FleetAlignmentPlan>;
  create(input: {
    hostId: string;
    expectedDigest?: string;
    requestedBy: string;
    source: string;
  }): Promise<FleetAlignmentRequest>;
  approve(id: string, approvedBy: string): Promise<FleetAlignmentRequest>;
  cancel(id: string): Promise<FleetAlignmentRequest>;
  list(): FleetAlignmentRequest[];
  get(id: string): FleetAlignmentRequest | undefined;
}

export class AlignmentError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "AlignmentError";
  }
}

interface AlignmentFile {
  version: 1;
  requests: FleetAlignmentRequest[];
}

export interface FleetAlignmentServiceOptions {
  path: string;
  fleet: Pick<WhaleFleetServiceV1, "manifest" | "plan" | "diff"> & Partial<Pick<WhaleFleetServiceV1, "refresh">>;
  manager: () => AlignmentPluginManager | undefined;
  now?: () => number;
  limit?: number;
}

export function createFleetAlignmentService(options: FleetAlignmentServiceOptions): WhaleAlignmentServiceV1 {
  const now = options.now ?? Date.now;
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  let requests = load(options.path);

  const save = (): void => {
    requests = requests.slice(-limit);
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    const temporary = `${options.path}.${process.pid}.tmp`;
    const file: AlignmentFile = { version: 1, requests };
    writeFileSync(temporary, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* best effort */ }
    renameSync(temporary, options.path);
  };

  const update = (id: string, change: (request: FleetAlignmentRequest) => void): FleetAlignmentRequest => {
    const request = requests.find(candidate => candidate.id === id);
    if (request === undefined) throw new AlignmentError("alignment/not-found", "对齐请求不存在");
    change(request);
    request.updatedAt = new Date(now()).toISOString();
    save();
    return structuredClone(request);
  };

  const buildPlan = async (hostId: string, expectedDigest?: string): Promise<FleetAlignmentPlan> => {
    const local = await options.fleet.manifest();
    if (hostId !== local.hostId) throw new AlignmentError("alignment/local-only", "v1 只允许本机对齐");
    const plan = await options.fleet.plan(hostId, expectedDigest);
    if (plan.overall === "unknown" && plan.steps.length === 0) {
      throw new AlignmentError("alignment/plan-unavailable", plan.note ?? "无法生成对齐计划");
    }
    const manager = options.manager();
    let bundles: AlignmentBundle[] = [];
    try {
      bundles = await manager?.listBundles?.() ?? [];
    } catch {
      bundles = [];
    }
    const known = new Map(bundles.map(bundle => [bundle.name, bundle]));
    const steps = plan.steps.map(step => classify(step, known, manager));
    return {
      contractVersion: 1,
      hostId,
      planDigest: digestOf(plan),
      plan,
      steps,
    };
  };

  const plan = async (hostId: string, expectedDigest?: string): Promise<FleetAlignmentPlan> =>
    await buildPlan(hostId, expectedDigest);

  const create = async (input: {
    hostId: string;
    expectedDigest?: string;
    requestedBy: string;
    source: string;
  }): Promise<FleetAlignmentRequest> => {
    const built = await buildPlan(input.hostId, input.expectedDigest);
    const timestamp = new Date(now()).toISOString();
    const request: FleetAlignmentRequest = {
      contractVersion: 1,
      id: randomUUID(),
      hostId: input.hostId,
      requestedBy: input.requestedBy,
      source: input.source,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "pending",
      planDigest: built.planDigest,
      plan: built.plan,
      steps: built.steps,
    };
    requests.push(request);
    save();
    return structuredClone(request);
  };

  const approve = async (id: string, approvedBy: string): Promise<FleetAlignmentRequest> => {
    const request = requests.find(candidate => candidate.id === id);
    if (request === undefined) throw new AlignmentError("alignment/not-found", "对齐请求不存在");
    if (request.status !== "pending") throw new AlignmentError("alignment/state", "只有待批准请求可以执行");
    const manager = options.manager();
    if (manager === undefined) throw new AlignmentError("alignment/unavailable", "pluginManager 不可用");

    const current = await buildPlan(request.hostId, request.plan.expectedDigest === "" ? undefined : request.plan.expectedDigest);
    if (current.planDigest !== request.planDigest) {
      throw new AlignmentError("alignment/plan-changed", "环境已变化，请重新生成计划");
    }

    const before = await options.fleet.manifest();
    const beforeBundles = await snapshot(manager);
    request.status = "running";
    request.approvedBy = approvedBy;
    request.startedAt = new Date(now()).toISOString();
    request.updatedAt = request.startedAt;
    request.beforeDigest = before.environmentDigest;
    save();

    const results: AlignmentStepResult[] = [];
    let failed = false;
    for (const step of current.steps) {
      if (step.exec === "manual") {
        results.push({
          stepId: step.id, action: step.action, target: step.target, status: "manual",
          ...(step.manualReason === undefined ? {} : { detail: step.manualReason }),
        });
        continue;
      }
      try {
        await executeStep(manager, step);
        results.push({ stepId: step.id, action: step.action, target: step.target, status: "executed" });
      } catch (error) {
        failed = true;
        results.push({
          stepId: step.id, action: step.action, target: step.target, status: "failed",
          detail: safeMessage(error),
        });
        break;
      }
    }

    let rollback: AlignmentStepResult[] = [];
    if (failed) {
      rollback = await rollbackSteps(manager, current.steps, results, beforeBundles);
    }

    let after: FleetDriftReport | undefined;
    try {
      await options.fleet.refresh?.();
      after = await options.fleet.diff(request.hostId, request.plan.expectedDigest === "" ? undefined : request.plan.expectedDigest);
    } catch (error) {
      results.push({
        stepId: "recollect", action: "verify", target: request.hostId, status: "failed",
        detail: safeMessage(error),
      });
      failed = true;
    }

    const manual = results.some(result => result.status === "manual");
    request.results = results;
    request.rollback = rollback;
    if (after === undefined) {
      delete request.after;
      delete request.afterDigest;
    } else {
      request.after = after;
      if (typeof after.observedDigest === "string") request.afterDigest = after.observedDigest;
      else delete request.afterDigest;
    }
    request.finishedAt = new Date(now()).toISOString();
    request.updatedAt = request.finishedAt;
    request.status = failed ? "failed"
      : manual ? "manual-required"
      : after?.overall === "match" ? "succeeded"
      : "partial";
    if (failed) {
      request.error = results.find(result => result.status === "failed")?.detail ?? "alignment/failed";
      request.status = "failed";
    }
    save();
    return structuredClone(request);
  };

  const cancel = async (id: string): Promise<FleetAlignmentRequest> => {
    return update(id, request => {
      if (request.status !== "pending") throw new AlignmentError("alignment/state", "只有待批准请求可以取消");
      request.status = "cancelled";
    });
  };

  return {
    contractVersion: 1,
    plan,
    create,
    approve,
    cancel,
    list: () => requests.map(request => structuredClone(request)),
    get: id => {
      const request = requests.find(candidate => candidate.id === id);
      return request === undefined ? undefined : structuredClone(request);
    },
  };
}

function classify(
  step: FleetPlanStep,
  known: Map<string, AlignmentBundle>,
  manager: AlignmentPluginManager | undefined,
): AlignmentStepPlan {
  if (manager === undefined) {
    return { ...step, exec: "manual", manualReason: "pluginManager 不可用" };
  }
  if (step.action === "enable") {
    return known.has(step.target)
      ? { ...step, exec: "auto" }
      : { ...step, exec: "manual", manualReason: "本机没有该 bundle" };
  }
  if (step.action === "install" || step.action === "update") {
    if (manager.installBundle === undefined) {
      return { ...step, exec: "manual", manualReason: "宿主没有 installBundle" };
    }
    if (step.spec === undefined) {
      return { ...step, exec: "manual", manualReason: "期望清单没有可安装的版本或来源" };
    }
    return { ...step, exec: "auto" };
  }
  return { ...step, exec: "manual", manualReason: "v1 只自动执行 install/update/enable" };
}

async function executeStep(manager: AlignmentPluginManager, step: AlignmentStepPlan): Promise<void> {
  if (step.action === "enable") {
    await manager.setBundleEnabled(step.target, true);
    return;
  }
  if ((step.action === "install" || step.action === "update") && step.spec !== undefined) {
    await manager.installBundle!(step.spec, {
      enabled: true,
      saveExact: true,
      ...(step.expectedVersion === undefined ? {} : { expected: { name: step.target, version: step.expectedVersion } }),
    });
    return;
  }
  throw new AlignmentError("alignment/unsupported", "不支持的对齐动作");
}

async function snapshot(manager: AlignmentPluginManager): Promise<Map<string, AlignmentBundle>> {
  try {
    return new Map((await manager.listBundles()).map(bundle => [bundle.name, bundle]));
  } catch {
    return new Map();
  }
}

async function rollbackSteps(
  manager: AlignmentPluginManager,
  steps: AlignmentStepPlan[],
  results: AlignmentStepResult[],
  before: Map<string, AlignmentBundle>,
): Promise<AlignmentStepResult[]> {
  const rollback: AlignmentStepResult[] = [];
  const executed = new Set(results.filter(result => result.status === "executed").map(result => result.stepId));
  for (const step of [...steps].reverse()) {
    if (!executed.has(step.id)) continue;
    try {
      if (step.action === "enable") {
        if (before.get(step.target)?.enabled === false) await manager.setBundleEnabled(step.target, false);
      } else if (step.action === "install") {
        if (before.has(step.target) === false) await manager.setBundleEnabled(step.target, false);
      } else if (step.action === "update") {
        const previous = before.get(step.target);
        if (previous?.version !== undefined && manager.installBundle !== undefined) {
          await manager.installBundle(`${step.target}@${previous.version}`, {
            enabled: previous.enabled,
            saveExact: true,
            expected: { name: step.target, version: previous.version },
          });
        }
      }
      rollback.push({ stepId: step.id, action: step.action, target: step.target, status: "rolled-back" });
    } catch (error) {
      rollback.push({
        stepId: step.id, action: step.action, target: step.target, status: "failed",
        detail: `rollback: ${safeMessage(error)}`,
      });
    }
  }
  return rollback;
}

function digestOf(plan: FleetPlanReport): string {
  return `sha256:${sha256Hex(canonicalJson({
    hostId: plan.hostId,
    expectedDigest: plan.expectedDigest,
    observedDigest: plan.observedDigest,
    overall: plan.overall,
    steps: plan.steps,
  }))}`;
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[\r\n]+/gu, " ").slice(0, 200);
}

function load(path: string): FleetAlignmentRequest[] {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { requests?: unknown };
    if (!Array.isArray(parsed.requests)) return [];
    return parsed.requests.filter((value): value is FleetAlignmentRequest => {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
      const request = value as Partial<FleetAlignmentRequest>;
      return request.contractVersion === 1
        && typeof request.id === "string"
        && typeof request.hostId === "string"
        && typeof request.status === "string"
        && typeof request.planDigest === "string"
        && request.plan !== undefined && Array.isArray(request.steps);
    });
  } catch {
    return [];
  }
}
