import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execCapabilityProbeCommand, parseExecCapabilityProbe } from "./exec-capability-probe.js";

const complete = ["FUSION_EXEC_PROBE=1", "CHECK_COUNT=3", "CHECK_tool_flock=1", "CHECK_proc=1", "CHECK_job_root=1", "FUSION_EXEC_PROBE_END=1"].join("\n");
const parse = (stdout: string) => parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout, checkedAt: 1000 });

describe("exec capability probe", () => {
  it("rejects a self-consistent count when an expected startup tool is missing", () => {
    const result = parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout: complete, expectedTools: ["flock", "setsid"] });
    expect(result).toMatchObject({ state: "unknown", reasonCodes: ["EXEC_PROBE_INVALID"], checks: [] });
  });
  it("requires the exact expected tool set, independent of ordering", () => {
    expect(parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout: complete, expectedTools: ["setsid"] }).state).toBe("unknown");
    expect(parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout: complete, expectedTools: ["flock"] }).state).toBe("supported");
    const stdout = complete.replace("CHECK_COUNT=3", "CHECK_COUNT=4").replace("CHECK_proc=1", "CHECK_tool_setsid=1\nCHECK_proc=1");
    expect(parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout, expectedTools: ["setsid", "flock"] }).state).toBe("supported");
    expect(parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout, expectedTools: ["flock"] }).state).toBe("unknown");
  });
  it("accepts complete evidence with a 30 second TTL", () => {
    expect(parse(complete)).toMatchObject({ state: "supported", checkedAt: 1000, expiresAt: 31000, reasonCodes: [], checks: [{ id: "tool_flock", ok: true }, { id: "proc", ok: true }, { id: "job_root", ok: true }] });
  });
  it.each([['tool_flock', 'EXEC_TOOL_MISSING'], ['proc', 'EXEC_PROC_UNAVAILABLE'], ['job_root', 'EXEC_JOB_ROOT_UNWRITABLE']])("reports an explicit failed prerequisite %s", (id, reason) => {
    expect(parse(complete.replace(`CHECK_${id}=1`, `CHECK_${id}=0`))).toMatchObject({ state: "unsupported", reasonCodes: [reason] });
  });
  it.each(["", complete.replace("FUSION_EXEC_PROBE_END=1", ""), complete.replace("CHECK_proc=1\n", ""), complete + "\nCHECK_proc=1", complete.replace("CHECK_proc=1", "CHECK_proc=yes"), complete.replace("CHECK_tool_flock=1", "CHECK_other=1"), complete + "\n/private/error", "x".repeat(65537)])("treats malformed or truncated evidence as unknown", (stdout) => {
    expect(parse(stdout)).toMatchObject({ state: "unknown", reasonCodes: ["EXEC_PROBE_INVALID"], checks: [] });
  });
  it("does not expose untrusted stdout in the observation", () => {
    expect(JSON.stringify(parse("private-path command secret"))).not.toMatch(/private-path|command secret/);
  });
  it("rejects future observation timestamps without issuing future evidence", () => {
    const result = parseExecCapabilityProbe({ nodeId: "node", providerId: "provider", stdout: complete, checkedAt: Date.now() + 60_000 });
    expect(result.state).toBe("unknown");
    expect(result.checkedAt).toBeLessThanOrEqual(Date.now());
    expect(result.expiresAt).toBe(result.checkedAt + 30_000);
  });
  it("executes the generated shell with boolean-only output and never creates a missing root", async () => {
    const execute = promisify(execFile);
    const root = `/tmp/fusion-probe-absent-${process.pid}-${Date.now()}/nested`;
    const command = execCapabilityProbeCommand(root, ["printf", "fusion_nonexistent_tool_fixture"]);
    const { stdout } = await execute(process.platform === "win32" ? "C:/Program Files/Git/bin/bash.exe" : "bash", ["-c", `${command}\n[ ! -e '${root}' ]`], { timeout: 10_000 });
    const result = parse(stdout);
    expect(result.state).toBe("unsupported");
    expect(result.checks).toContainEqual({ id: "tool_printf", ok: true });
    expect(result.checks).toContainEqual({ id: "tool_fusion_nonexistent_tool_fixture", ok: false });
    expect(result.checks).toContainEqual({ id: "job_root", ok: true });
    expect(stdout).not.toContain(root);
  });
  it("generates only read-only tests, quotes the root, and declares the full check count", () => {
    const command = execCapabilityProbeCommand("/private/it's/jobs", ["flock", "setsid"]);
    expect(command).toContain("CHECK_COUNT=4");
    expect(command).toContain("command -v");
    expect(command).toContain("/proc/self/stat");
    expect(command).toContain("${probe_dir%/*}");
    expect(command).toContain("-w");
    expect(command).toContain("'\"'\"'");
    expect(command).not.toMatch(/\b(mkdir|mkfifo|touch|chmod|nohup|eval)\b|>\s*[^&/]/);
  });
  it("rejects unsafe tool names and nonabsolute paths before any execution", () => {
    expect(() => execCapabilityProbeCommand("relative", ["flock"])).toThrow();
    expect(() => execCapabilityProbeCommand("/tmp/jobs", ["flock;touch hacked"])).toThrow();
  });
});
