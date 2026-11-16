import { describe, expect, it } from "vitest";
import { normalizeFleetNodeDefinitions } from "./fleet-node-definitions.js";

describe("fleet node definitions", () => {
  it("normalizes independent SSH and Instabox nodes by reference", () => {
    expect(normalizeFleetNodeDefinitions({
      sshNodes: [{
        nodeId: "worker-a",
        host: "worker-a.example",
        keyPath: "/run/credentials/worker-a",
        knownHostsPath: "/etc/dsh-fusion/known_hosts",
        name: "Worker A",
      }],
      instaboxNodes: [{
        nodeId: "box-a",
        machineName: "dsh-fusion-test",
        timeoutMs: 30_000,
      }],
    })).toEqual({
      sshNodes: [{
        nodeId: "worker-a",
        host: "worker-a.example",
        keyPath: "/run/credentials/worker-a",
        knownHostsPath: "/etc/dsh-fusion/known_hosts",
        name: "Worker A",
      }],
      instaboxNodes: [{
        nodeId: "box-a",
        machineName: "dsh-fusion-test",
        timeoutMs: 30_000,
      }],
    });
  });

  it("keeps the Instabox job root and output limit through normalization", () => {
    expect(normalizeFleetNodeDefinitions({
      instaboxNodes: [{
        nodeId: "box-a",
        machineName: "dsh-fusion-test",
        jobRoot: "/tmp/custom-instabox-jobs",
        outputLimitBytes: 131_072,
      }],
    })).toEqual({
      sshNodes: [],
      instaboxNodes: [{
        nodeId: "box-a",
        machineName: "dsh-fusion-test",
        jobRoot: "/tmp/custom-instabox-jobs",
        outputLimitBytes: 131_072,
      }],
    });
  });

  it("normalizes host ownership, sharing and concurrency policy", () => {
    expect(normalizeFleetNodeDefinitions({
      sshNodes: [{
        nodeId: "worker-a",
        host: "worker-a.example",
        keyPath: "/key",
        knownHostsPath: "/known_hosts",
        hostAccess: {
          ownerId: " team-alpha ",
          sharingMode: "shared",
          maxConcurrentTasks: 3,
        },
      }],
    }).sshNodes[0]?.hostAccess).toEqual({
      ownerId: "team-alpha",
      sharingMode: "shared",
      maxConcurrentTasks: 3,
    });
  });

  it("requires an owner for a shared host and bounds its task quota", () => {
    expect(() => normalizeFleetNodeDefinitions({
      sshNodes: [{
        nodeId: "worker-a",
        host: "worker-a.example",
        keyPath: "/key",
        knownHostsPath: "/known_hosts",
        hostAccess: { sharingMode: "shared" },
      }],
    })).toThrow("FLEET_HOST_OWNER_REQUIRED:worker-a");

    for (const maxConcurrentTasks of [0, 1.5, 65]) {
      expect(() => normalizeFleetNodeDefinitions({
        sshNodes: [{
          nodeId: "worker-a",
          host: "worker-a.example",
          keyPath: "/key",
          knownHostsPath: "/known_hosts",
          hostAccess: { sharingMode: "dedicated", maxConcurrentTasks },
        }],
      })).toThrow("FLEET_HOST_CONCURRENCY_INVALID:worker-a");
    }
  });

  it("rejects an out-of-range Instabox output limit", () => {
    for (const outputLimitBytes of [0, 15, 512 * 1024 + 1, 1.5]) {
      expect(() => normalizeFleetNodeDefinitions({
        instaboxNodes: [{ nodeId: "box-a", machineName: "box", outputLimitBytes }],
      })).toThrow("FLEET_OUTPUT_LIMIT_INVALID:box-a");
    }
  });

  it("rejects duplicate node ids across provider families", () => {
    expect(() => normalizeFleetNodeDefinitions({
      sshNodes: [{
        nodeId: "same",
        host: "ssh.example",
        keyPath: "/key",
        knownHostsPath: "/known_hosts",
      }],
      instaboxNodes: [{ nodeId: "same", machineName: "box" }],
    })).toThrow("FLEET_NODE_ID_DUPLICATE:same");
  });

  it("rejects a partially configured SSH node", () => {
    expect(() => normalizeFleetNodeDefinitions({
      sshNodes: [{
        nodeId: "worker-a",
        host: "worker-a.example",
        keyPath: "",
        knownHostsPath: "/known_hosts",
      }],
    })).toThrow("FLEET_SSH_KEY_REQUIRED:worker-a");
  });
});
