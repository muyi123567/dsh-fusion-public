import { describe, expect, it } from "vitest";
import { loadFleetConfig, renderNode } from "./index.js";

const fixture = loadFleetConfig(`
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
base:
  paths:
    aiRoot: /srv/ai
  capabilities: [dsh]
roles:
  worker:
    capabilities: [worker]
nodes:
  windows-main:
    platform: windows
    roles: [control, worker]
    paths:
      aiRoot: "F:\\\\AI"
    capabilities: [windows, powershell]
  tencent:
    platform: linux
    roles: [worker]
    paths:
      aiRoot: /home/agentuser/AI
    capabilities: [linux, pytest]
`);

describe("renderNode", () => {
  it("renders node-specific paths without leaking another node", () => {
    const result = renderNode(fixture, "tencent");
    expect(result.paths.aiRoot).toBe("/home/agentuser/AI");
    expect(JSON.stringify(result)).not.toContain("F:\\\\AI");
  });

  it("applies role capabilities after base and before node capabilities", () => {
    const result = renderNode(fixture, "tencent");
    expect(result.capabilities).toEqual(["dsh", "worker", "linux", "pytest"]);
  });

  it("changes the hash when a role changes the rendered path or capabilities", () => {
    const renderFixture = (rolePath: string, roleCapabilities: string) => loadFleetConfig(`
version: 1
defaults:
  dshVersion: 0.2.0-rc.2
  transport: seekfleet
base:
  paths:
    aiRoot: /srv/ai
  capabilities: [dsh]
roles:
  worker:
    capabilities: [${roleCapabilities}]
    paths:
      aiRoot: ${rolePath}
nodes:
  tencent:
    platform: linux
    roles: [worker]
    workspaceRoots: [/home/agentuser/AI]
    capabilities: [linux, pytest]
`);
    const original = renderNode(renderFixture("/srv/role", "worker"), "tencent");
    const changedPath = renderFixture("/srv/changed", "worker");
    const changedCapabilities = renderFixture("/srv/role", "worker, role-change");

    expect(renderNode(changedPath, "tencent").hash).not.toBe(original.hash);
    expect(renderNode(changedCapabilities, "tencent").hash).not.toBe(original.hash);
  });
});
