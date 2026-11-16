import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFleetNodeConfig } from "./fleet-node-config.js";

let tempRoot: string;
let fleetConfigPath: string;

const FLEET_CONFIG = `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
base:
  capabilities: [dsh]
roles:
  worker:
    capabilities: [worker]
nodes:
  huawei-hs-monitor-cn:
    platform: linux
    transport: ssh
    roles: [worker]
    workspaceRoots: [/srv/projects]
    capabilities: [linux, monitor]
  oracle:
    platform: linux
    transport: ssh
    roles: [worker]
    workspaceRoots: [/srv/oracle]
    capabilities: [linux, gpu]
`;

async function writeFixture(name: string, source: string): Promise<string> {
  const path = join(tempRoot, `${name}.yaml`);
  await writeFile(path, source, "utf8");
  return path;
}

function workspaceFixture(workspaceRoot: string): string {
  return `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
nodes:
  node:
    platform: linux
    transport: ssh
    roles: [worker]
    workspaceRoots: [${workspaceRoot}]
`;
}

describe("loadFleetNodeConfig", () => {
  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "dsh-fusion-fleet-"));
    fleetConfigPath = await writeFixture("fleet", FLEET_CONFIG);
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("maps the selected fleet node to the runtime remote config identity", () => {
    expect(loadFleetNodeConfig(fleetConfigPath, {
      fleetNodeId: "huawei-hs-monitor-cn",
      runtimeNodeId: "runtime-huawei",
      displayName: "Huawei monitor",
    })).toEqual({
      nodeId: "runtime-huawei",
      displayName: "Huawei monitor",
      dshVersion: "0.2.0-rc.2",
      workspaceRoot: "/srv/projects",
      capabilities: ["dsh", "worker", "linux", "monitor"],
    });
  });

  it("does not leak paths or capabilities between fleet nodes", () => {
    const result = loadFleetNodeConfig(fleetConfigPath, {
      fleetNodeId: "oracle",
      runtimeNodeId: "runtime-oracle",
      displayName: "Oracle",
    });

    expect(result.workspaceRoot).toBe("/srv/oracle");
    expect(result.capabilities).toEqual(["dsh", "worker", "linux", "gpu"]);
    expect(JSON.stringify(result)).not.toContain("/srv/projects");
    expect(result.capabilities).not.toContain("monitor");
  });

  it("fails closed unless exactly one workspace root is rendered", async () => {
    const zero = await writeFixture("zero-workspaces", `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
nodes:
  node:
    platform: linux
    transport: ssh
    roles: [worker]
`);
    const multiple = await writeFixture("multiple-workspaces", `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
nodes:
  node:
    platform: linux
    transport: ssh
    roles: [worker]
    workspaceRoots: [/srv/a, /srv/b]
`);

    expect(() => loadFleetNodeConfig(zero, {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_WORKSPACE_ROOT_COUNT:node:0/);
    expect(() => loadFleetNodeConfig(multiple, {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_WORKSPACE_ROOT_COUNT:node:2/);
  });

  it("requires Linux nodes over SSH", async () => {
    const nonLinux = await writeFixture("non-linux", `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
nodes:
  node:
    platform: windows
    transport: ssh
    roles: [worker]
    workspaceRoots: [C:\\\\AI]
`);
    const nonSsh = await writeFixture("non-ssh", `
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
nodes:
  node:
    platform: linux
    transport: seekfleet
    roles: [worker]
    workspaceRoots: [/srv/projects]
`);

    expect(() => loadFleetNodeConfig(nonLinux, {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_PLATFORM_UNSUPPORTED:node:windows/);
    expect(() => loadFleetNodeConfig(nonSsh, {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_TRANSPORT_UNSUPPORTED:node:seekfleet/);
  });

  it("explicitly normalizes an otherwise valid POSIX workspace root", async () => {
    const configPath = await writeFixture(
      "normalized-workspace",
      workspaceFixture('"/srv//projects/./"'),
    );

    expect(loadFleetNodeConfig(configPath, {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    }).workspaceRoot).toBe("/srv/projects");
  });

  it("rejects non-canonical, unsafe, and Windows workspace roots", async () => {
    const cases = [
      ["relative", '"relative/projects"', "NOT_ABSOLUTE"],
      ["root", '"/"', "ROOT"],
      ["parent-segment", '"/srv/../etc"', "PARENT_SEGMENT"],
      ["control", '"/srv/\\u0000projects"', "CONTROL_CHARACTER"],
      ["drive", '"C:\\\\AI"', "WINDOWS_PATH"],
      ["backslash-unc", '"\\\\\\\\server\\\\share"', "UNC_PATH"],
      ["slash-unc", '"//server/share"', "UNC_PATH"],
      ["backslash", '"/srv\\\\projects"', "WINDOWS_PATH"],
    ] as const;

    for (const [name, workspaceRoot, reason] of cases) {
      const configPath = await writeFixture(`invalid-workspace-${name}`, workspaceFixture(workspaceRoot));
      expect(() => loadFleetNodeConfig(configPath, {
        fleetNodeId: "node",
        runtimeNodeId: "runtime",
        displayName: "Runtime",
      })).toThrow(`FLEET_CONFIG_WORKSPACE_ROOT_INVALID:node:${reason}`);
    }
  });

  it("fails closed for missing, malformed, and unknown-node configurations", async () => {
    const malformed = await writeFixture("malformed", "version: [");
    const unknownNode = await writeFixture("unknown-node", FLEET_CONFIG);

    expect(() => loadFleetNodeConfig(join(tempRoot, "missing.yaml"), {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_FILE_NOT_FOUND/);
    expect(() => loadFleetNodeConfig(malformed, {
      fleetNodeId: "node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_INVALID/);
    expect(() => loadFleetNodeConfig(unknownNode, {
      fleetNodeId: "missing-node",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_NODE_NOT_FOUND:missing-node/);
  });

  it("rejects relative configuration paths", () => {
    expect(() => loadFleetNodeConfig("config/fleet.yaml", {
      fleetNodeId: "huawei-hs-monitor-cn",
      runtimeNodeId: "runtime",
      displayName: "Runtime",
    })).toThrow(/FLEET_CONFIG_PATH_NOT_ABSOLUTE/);
  });
});
