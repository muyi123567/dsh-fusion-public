import { DEFAULT_EXEC_CAPABILITY_TTL_MS, type ExecCapabilityObservation } from "@dsh-fusion/core";

// Wire format v1: header, count, one boolean per check, end marker. No paths or errors.
const SOURCE = "exec-capability-probe/v1";
const SAFE_TOOL = /^[a-z][a-z0-9_-]{0,63}$/u;
const quote = (value: string): string => `'${value.replace(/'/gu, `'"'"'`)}'`;

export function execCapabilityProbeCommand(jobRoot: string, tools: readonly string[]): string {
  if (!jobRoot.startsWith("/") || /[\x00-\x1f\x7f]/u.test(jobRoot) || jobRoot.split("/").some((part) => part === "." || part === "..")) {
    throw new Error("EXEC_PROBE_INVALID_ROOT");
  }
  const unique = [...new Set(tools)];
  if (unique.length === 0 || unique.length > 128 || unique.some((tool) => !SAFE_TOOL.test(tool))) throw new Error("EXEC_PROBE_INVALID_TOOLS");
  return [
    "# FUSION_EXEC_CAPABILITY_PROBE_V1",
    "printf 'FUSION_EXEC_PROBE=1\\n'",
    `printf 'CHECK_COUNT=${unique.length + 2}\\n'`,
    ...unique.map((tool) => `if command -v ${quote(tool)} >/dev/null 2>&1; then printf 'CHECK_tool_${tool}=1\\n'; else printf 'CHECK_tool_${tool}=0\\n'; fi`),
    "if [ -d /proc ] && [ -r /proc/self/stat ] && [ -r /proc/sys/kernel/random/boot_id ]; then printf 'CHECK_proc=1\\n'; else printf 'CHECK_proc=0\\n'; fi",
    `probe_dir=${quote(jobRoot.replace(/\/+$/u, "") || "/")}`,
    'while [ ! -e "$probe_dir" ] && [ ! -L "$probe_dir" ]; do',
    '  probe_dir=${probe_dir%/*}',
    '  if [ -z "$probe_dir" ]; then probe_dir=/; fi',
    "done",
    'if [ -d "$probe_dir" ] && [ ! -L "$probe_dir" ] && [ -w "$probe_dir" ] && [ -x "$probe_dir" ]; then',
    "  printf 'CHECK_job_root=1\\n'",
    "else",
    "  printf 'CHECK_job_root=0\\n'",
    "fi",
    "printf 'FUSION_EXEC_PROBE_END=1\\n'",
  ].join("\n");
}

export function parseExecCapabilityProbe(input: {
  nodeId: string;
  providerId: string;
  stdout: string;
  checkedAt?: number;
  expectedTools?: readonly string[];
}): ExecCapabilityObservation {
  const now = Date.now();
  const checkedAt = input.checkedAt !== undefined && Number.isFinite(input.checkedAt) && input.checkedAt >= 0 && input.checkedAt <= now ? input.checkedAt : now;
  const base = { nodeId: input.nodeId, providerId: input.providerId, checkedAt, expiresAt: checkedAt + DEFAULT_EXEC_CAPABILITY_TTL_MS, source: SOURCE };
  const unknown = (): ExecCapabilityObservation => ({ ...base, state: "unknown", reasonCodes: ["EXEC_PROBE_INVALID"], checks: [] });
  if (input.checkedAt !== undefined && (!Number.isFinite(input.checkedAt) || input.checkedAt < 0 || input.checkedAt > now)) return unknown();
  if (input.stdout.length > 65536) return unknown();
  const lines = input.stdout.replace(/\r\n/gu, "\n").replace(/\n$/u, "").split("\n");
  if (lines[0] !== "FUSION_EXEC_PROBE=1" || lines.at(-1) !== "FUSION_EXEC_PROBE_END=1") return unknown();
  const countMatch = /^CHECK_COUNT=([1-9][0-9]{0,2})$/u.exec(lines[1] ?? "");
  if (!countMatch) return unknown();
  const entries = lines.slice(2, -1);
  if (Number(countMatch[1]) !== entries.length || entries.length < 3 || entries.length > 130) return unknown();
  const checks: ExecCapabilityObservation["checks"] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    const match = /^CHECK_(proc|job_root|tool_[a-z][a-z0-9_-]{0,63})=([01])$/u.exec(entry);
    if (!match || ids.has(match[1]!)) return unknown();
    ids.add(match[1]!);
    checks.push({ id: match[1]!, ok: match[2] === "1" });
  }
  if (!ids.has("proc") || !ids.has("job_root") || !checks.some((check) => check.id.startsWith("tool_"))) return unknown();
  if (input.expectedTools !== undefined) {
    const tools = [...new Set(input.expectedTools)];
    if (tools.length === 0 || tools.length > 128 || tools.some((tool) => !SAFE_TOOL.test(tool))) return unknown();
    const expected = new Set(["proc", "job_root", ...tools.map((tool) => `tool_${tool}`)]);
    if (ids.size !== expected.size || [...expected].some((id) => !ids.has(id))) return unknown();
  }
  const reasonCodes = [...new Set(checks.filter((check) => !check.ok).map((check) => check.id === "proc" ? "EXEC_PROC_UNAVAILABLE" : check.id === "job_root" ? "EXEC_JOB_ROOT_UNWRITABLE" : "EXEC_TOOL_MISSING"))];
  return { ...base, state: reasonCodes.length === 0 ? "supported" : "unsupported", reasonCodes, checks };
}
