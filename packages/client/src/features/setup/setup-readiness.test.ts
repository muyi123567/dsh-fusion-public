import { describe, expect, it } from "vitest";
import type { ConfigSnapshot, NodeRecord } from "@dsh-fusion/core";
import { buildSetupReadiness } from "./setup-readiness.js";

const config: ConfigSnapshot = {
  revision: "rev-1",
  hash: "sha256:config",
  pluginVersions: { "dsh-fusion": "0.2.0-beta.8" },
  nodeStates: {},
};

const node: NodeRecord = {
  id: "worker-a",
  externalId: "worker-a",
  providerId: "huawei-ssh",
  name: "Worker A",
  platform: "linux",
  roles: ["worker"],
  status: "online",
  transports: ["ssh"],
  capabilities: ["config"],
  configState: "current",
};

describe("setup readiness", () => {
  it("asks for a node before offering a first task", () => {
    const readiness = buildSetupReadiness({
      snapshotLoaded: true,
      pluginMode: true,
      nodes: [],
      providers: {},
      config,
    });

    expect(readiness.nextAction).toMatchObject({
      label: "添加执行节点",
      target: "config",
    });
    expect(readiness.checks.find((check) => check.id === "nodes")).toMatchObject({
      tone: "attention",
    });
  });

  it("routes an offline configured fleet to connection checks", () => {
    const readiness = buildSetupReadiness({
      snapshotLoaded: true,
      pluginMode: true,
      nodes: [{ ...node, status: "offline" }],
      providers: {},
      config: { ...config, nodeStates: { "worker-a": "current" } },
    });

    expect(readiness.nextAction).toMatchObject({
      label: "检查节点连接",
      target: "fleet",
    });
  });

  it("prioritizes configuration drift over starting work", () => {
    const readiness = buildSetupReadiness({
      snapshotLoaded: true,
      pluginMode: true,
      nodes: [{ ...node, configState: "drift" }],
      providers: {},
      config: { ...config, nodeStates: { "worker-a": "drift" } },
    });

    expect(readiness.nextAction).toMatchObject({
      label: "处理配置漂移",
      target: "config",
    });
  });

  it("does not treat a partially verified fleet as configuration-ready", () => {
    const readiness = buildSetupReadiness({
      snapshotLoaded: true,
      pluginMode: true,
      nodes: [
        node,
        { ...node, id: "worker-b", externalId: "worker-b", name: "Worker B", configState: "unknown" },
      ],
      providers: {},
      config: { ...config, nodeStates: { "worker-a": "current", "worker-b": "unknown" } },
    });

    expect(readiness.checks.find((check) => check.id === "config")).toMatchObject({
      tone: "attention",
      detail: "1/2 个节点配置已验证，仍有 1 个节点未验证",
    });
    expect(readiness.nextAction).toMatchObject({
      label: "验证节点配置",
      target: "config",
    });
  });

  it("offers a first task when required checks are ready and keeps collaboration optional", () => {
    const readiness = buildSetupReadiness({
      snapshotLoaded: true,
      pluginMode: true,
      nodes: [node],
      providers: {
        nodes: { state: "connected", checkedAt: 1 },
        room: { state: "connected", checkedAt: 1 },
      },
      config: { ...config, nodeStates: { "worker-a": "current" } },
    });

    expect(readiness.readyRequired).toBe(3);
    expect(readiness.totalRequired).toBe(3);
    expect(readiness.nextAction).toMatchObject({
      label: "发起首项多机任务",
      target: "tasks",
    });
    expect(readiness.checks.find((check) => check.id === "collaboration")).toMatchObject({
      tone: "ready",
      required: false,
    });
  });

  it("waits for the authoritative snapshot instead of treating local placeholders as ready", () => {
    const readiness = buildSetupReadiness({
      snapshotLoaded: false,
      pluginMode: true,
      nodes: [],
      providers: {},
      config: {
        revision: "unobserved",
        hash: "sha256:unobserved",
        pluginVersions: { "dsh-fusion": "0.1.0" },
        nodeStates: {},
      },
    });

    expect(readiness.checks.find((check) => check.id === "runtime")).toMatchObject({
      tone: "pending",
    });
    expect(readiness.nextAction).toMatchObject({
      label: "等待宿主快照",
      target: null,
    });
  });
});
