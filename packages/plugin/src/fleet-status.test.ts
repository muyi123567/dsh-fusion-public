import { describe, expect, it } from "vitest";
import { createFleetStatusService } from "./fleet-status.js";
import type { FleetHostManifest } from "./fleet-environment.js";

const LOCAL = `sha256:${"a".repeat(64)}`;
const REMOTE = `sha256:${"b".repeat(64)}`;
const SHA = `sha256:${"c".repeat(64)}`;

function manifest(hostId: string): FleetHostManifest {
  return {
    contractVersion: 1, hostId, displayName: hostId === LOCAL ? "local" : "remote",
    observedAt: "2026-11-24T06:00:00.000Z",
    dsh: { version: "0.2.3-alpha.2", profile: "web", node: "24.11.1", platform: "linux", arch: "arm64" },
    bundles: [], patches: { profile: null, home: null }, capabilities: {}, workspaces: [],
    providers: [], mcpServers: [], secrets: { present: [] }, environmentDigest: SHA,
    signature: { alg: "ed25519", keyId: "host:test", value: `${"A".repeat(86)}==` },
  };
}

describe("fleet status", () => {
  it("summarises every subsystem in one call without secrets", async () => {
    const service = createFleetStatusService({
      fleet: {
        manifest: async () => manifest(LOCAL),
        listHosts: async () => [
          {
            hostId: LOCAL, displayName: "local", observedAt: "2026-11-24T06:00:00.000Z", digest: SHA,
            overall: "drift", stale: false, signed: true, verified: true, trust: "verified",
          },
          {
            hostId: REMOTE, displayName: "remote", observedAt: "2026-11-24T06:00:00.000Z", digest: SHA,
            overall: "unknown", stale: true, signed: true, verified: false, trust: "untrusted",
          },
        ],
        trustReport: async () => ({
          mode: "manual",
          entries: [{
            hostId: LOCAL, publicKeyPem: "secret-public-pem", fingerprint: SHA, source: "manual",
            addedAt: "2026-11-24T06:00:00.000Z", updatedAt: "2026-11-24T06:00:00.000Z",
          }],
          hosts: [
            { hostId: LOCAL, displayName: "local", trust: "verified", verified: true, trusted: true, candidateKeyAvailable: true },
            { hostId: REMOTE, displayName: "remote", trust: "untrusted", verified: false, trusted: false, candidateKeyAvailable: true },
          ],
        }),
      },
      connectors: {
        catalog: () => [{}, {}, {}, {}] as never,
        instances: () => [
          { id: "a", kind: "gdrive", label: "A", enabled: true, state: "configured" },
          { id: "b", kind: "webdav", label: "B", enabled: true, state: "invalid" },
        ] as never,
      },
      notifications: {
        adapters: () => [
          { id: "ok", kind: "slack", label: "OK", enabled: true, state: "configured", events: [], capabilities: { receipt: false } },
          { id: "bad", kind: "telegram", label: "Bad", enabled: true, state: "invalid", events: [], capabilities: { receipt: false } },
        ] as never,
        receipts: () => [
          { adapterId: "ok", kind: "slack", eventType: "created", status: "failed", at: "", durationMs: 1 },
          { adapterId: "ok", kind: "slack", eventType: "created", status: "unknown", at: "", durationMs: 1 },
        ] as never,
      },
      presets: {
        list: () => [
          { id: "skill", kind: "skill", title: "Skill", description: "d", tags: [], status: { state: "installed" } },
          { id: "config", kind: "config", title: "Config", description: "d", tags: [] },
        ] as never,
      },
      backups: {
        list: () => [{
          id: "20261124T060000Z-aaaaaaaa", createdAt: "2026-11-24T06:00:00.000Z", reason: "startup", files: 3, bytes: 10,
        }],
      },
      alignment: {
        list: () => [
          { status: "pending" }, { status: "manual-required" }, { status: "failed" },
        ] as never,
      },
      requests: { list: async () => [{ status: "pending" }, { status: "approved" }] as never },
      now: () => Date.parse("2026-11-24T06:00:00Z"),
    });

    const report = await service.status();
    expect(report).toMatchObject({
      contractVersion: 1,
      host: { hostId: LOCAL, overall: "drift", verified: true, trust: "verified" },
      hosts: { total: 2, drift: 1, unknown: 1, stale: 1, untrusted: 1 },
      pending: { dispatch: 1, alignment: 1 },
      systems: {
        connectors: { providers: 4, configured: 1, invalid: 1 },
        notifications: { adapters: 2, invalid: 1, failed: 1, unknown: 1 },
        presets: { total: 2, installed: 1 },
        backups: { count: 1, latestAt: "2026-11-24T06:00:00.000Z" },
        trust: { entries: 1, untrusted: 1, invalid: 0, mode: "manual" },
        alignment: { pending: 1, manual: 1, failed: 1 },
      },
    });
    expect(report.nextActions).toEqual(expect.arrayContaining([
      "处理未信任或签名无效的远端清单",
      "配置期望环境或刷新状态未知的主机",
      "查看漂移并生成对齐计划",
      "等待人工批准待处理请求",
      "检查失败的对齐请求与回滚结果",
      "修复无效云盘连接器配置",
      "测试或修复通知适配器",
    ]));
    expect(JSON.stringify(report)).not.toContain("secret-public-pem");
  });
});
