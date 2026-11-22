import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  ExecCapabilityObservation,
  NodeRecord,
  NodeStatus,
  ProviderStatus,
  TaskEvidence,
  TaskRecord,
} from "@dsh-fusion/core";
import { createProviderStatus } from "@dsh-fusion/core";
import type { ExecutionMaterialWorkspaceFiles, FleetDispatchInput, FleetProvider } from "./fleet-provider.js";
import { normalizeEvidenceValue } from "../tasks/evidence.js";
import { execCapabilityProbeCommand, parseExecCapabilityProbe } from "./exec-capability-probe.js";
import { readWorkerExecutionObservation } from "./worker-execution.js";

export interface SshCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  failureKind?: HuaweiSshFailureKind;
  errorCode?: string;
}

export type SshCommandRunner = (command: string) => Promise<SshCommandResult>;

export type HuaweiSshFailureKind =
  | "host-key-changed"
  | "host-key-unverified"
  | "authentication-failed"
  | "key-error"
  | "timeout"
  | "unreachable"
  | "ssh-unavailable"
  | "command-failed";

export class HuaweiSshError extends Error {
  readonly name = "HuaweiSshError";

  constructor(
    readonly kind: HuaweiSshFailureKind,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
  }
}

export interface HuaweiSshArgumentOptions {
  host: string;
  keyPath: string;
  knownHostsPath?: string;
}

export interface HuaweiSshProviderOptions {
  host: string;
  keyPath: string;
  knownHostsPath?: string;
  sshPath?: string;
  providerId?: string;
  nodeId?: string;
  name?: string;
  timeoutMs?: number;
  jobRoot?: string;
  outputLimitBytes?: number;
  run?: SshCommandRunner;
}

const DEFAULT_JOB_ROOT = "/var/lib/dsh-fusion/jobs";
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MAX_OUTPUT_LIMIT_BYTES = 512 * 1024;
const MIN_OUTPUT_LIMIT_BYTES = 16;
const MAX_EXECUTION_MATERIAL_FILE_BYTES = 256 * 1024;
const MAX_EXECUTION_MATERIAL_TOTAL_BYTES = 512 * 1024;
const SAFE_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_WORKSPACE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_MATERIAL_PATH = /^[A-Za-z0-9._/-]{1,512}$/;
export const HUAWEI_JOB_REQUIRED_TOOLS = [
  "base64", "sha256sum", "sync", "date", "mkdir", "chmod", "cp", "mv", "rm", "sleep",
  "wc", "tr", "head", "cat", "mkfifo", "nohup", "setsid", "flock", "dd",
] as const;

const NODE_PROBE_COMMAND = [
  'printf \'HOST=%s\\n\' "$(hostname)"',
  'printf \'OS=%s\\n\' "$(. /etc/os-release; printf \'%s\' "$PRETTY_NAME")"',
  'printf \'ARCH=%s\\n\' "$(uname -m)"',
  'printf \'CPUS=%s\\n\' "$(nproc)"',
  'printf \'MEM=%s\\n\' "$(free | awk \'/Mem:/ {printf "%.1f", $3*100/$2}\')"',
  'printf \'DISK=%s\\n\' "$(df -P / | awk \'NR==2 {gsub(/%/,"",$5); print $5}\')"',
  'printf \'CPU=%s\\n\' "$(vmstat 1 2 | tail -1 | awk \'{print 100-$15}\')"',
  'printf \'SYSTEM=%s\\n\' "$(systemctl is-system-running || true)"',
  'printf \'FAILED=%s\\n\' "$(systemctl --failed --no-legend | wc -l)"',
  'printf \'LOAD=%s\\n\' "$(cut -d\' \' -f1-3 /proc/loadavg)"',
].join("\n");

const DOCTOR_COMMAND = [
  "# REMOTE_NODE_DOCTOR",
  "uname -a",
  "systemctl is-system-running || true",
  "systemctl --failed --no-legend || true",
  "free -m",
  "df -h /",
].join("\n");

function parseKeyValueLines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

function validExecutionMaterialPath(value: string): boolean {
  return SAFE_MATERIAL_PATH.test(value) && !value.startsWith("/")
    && !value.split("/").some(part => part === "" || part === "." || part === "..")
    && !value.includes("\\");
}

function parseExecutionMaterialFiles(
  stdout: string,
  workspaceId: string,
  paths: readonly string[],
): ExecutionMaterialWorkspaceFiles | undefined {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    if (line === "") continue;
    const separator = line.indexOf("=");
    if (separator < 1) return undefined;
    const key = line.slice(0, separator);
    if (values.has(key)) return undefined;
    values.set(key, line.slice(separator + 1));
  }
  const workspacePath = values.get("WORKSPACE_PATH");
  const sourceRevision = values.get("SOURCE_REVISION");
  const sourceDigest = values.get("SOURCE_SHA256");
  if (workspacePath === undefined || !workspacePath.startsWith("/") || workspacePath.length > 1024
    || workspacePath.includes("\\") || /[\u0000-\u001f\u007f]/u.test(workspacePath)
    || workspacePath.split("/").some(part => part === "." || part === "..")
    || sourceRevision === undefined || !/^\d{1,16}$/u.test(sourceRevision)
    || sourceDigest === undefined || !/^[a-f0-9]{64}$/u.test(sourceDigest)
    || values.get("WORKSPACE_ID") !== workspaceId || values.get("MATERIAL_COUNT") !== String(paths.length)) return undefined;

  const expectedKeys = new Set(["WORKSPACE_PATH", "WORKSPACE_ID", "SOURCE_REVISION", "SOURCE_SHA256", "MATERIAL_COUNT"]);
  const files: Array<{ path: string; bytes: Buffer; digest: string }> = [];
  let total = 0;
  for (const [index, path] of paths.entries()) {
    const prefix = `MATERIAL_${index}_`;
    const returnedPath = values.get(`${prefix}PATH`);
    const byteText = values.get(`${prefix}BYTES`);
    const encoded = values.get(`${prefix}BASE64`);
    if (returnedPath !== path || byteText === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(byteText)
      || encoded === undefined || encoded.length > 4 * Math.ceil(MAX_EXECUTION_MATERIAL_FILE_BYTES / 3)
      || Buffer.from(encoded, "base64").toString("base64") !== encoded) return undefined;
    const bytes = Buffer.from(encoded, "base64");
    const size = Number(byteText);
    if (!Number.isSafeInteger(size) || size !== bytes.length || size > MAX_EXECUTION_MATERIAL_FILE_BYTES) return undefined;
    total += size;
    if (total > MAX_EXECUTION_MATERIAL_TOTAL_BYTES) return undefined;
    files.push({ path, bytes, digest: createHash("sha256").update(bytes).digest("hex") });
    expectedKeys.add(`${prefix}PATH`);
    expectedKeys.add(`${prefix}BYTES`);
    expectedKeys.add(`${prefix}BASE64`);
  }
  if (values.size !== expectedKeys.size || [...values.keys()].some(key => !expectedKeys.has(key))) return undefined;
  return {
    workspaceId, workspacePath, sourceRevision, sourceDigest,
    files: files.map(({ path, digest, bytes }) => ({ path, digest, bytes: bytes.length })),
  };
}

function finiteNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function finitePercentage(value: string | undefined): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && parsed >= 0 && parsed <= 100 ? parsed : undefined;
}

function finiteCount(value: string | undefined): number | undefined {
  const parsed = finiteNumber(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Maps the remote systemd system state to node availability.
 *
 * A successful SSH probe already proved the node is reachable, so systemd only
 * downgrades it when the system itself is not in a usable state:
 *
 * - `running` / `degraded`: usable. `degraded` only means some unit failed,
 *   which is reported separately through `failedUnits`.
 * - `starting` / `stopping` / `offline` / `maintenance`: not usable yet.
 * - `""` / `unknown`: the host does not run systemd, which says nothing about
 *   reachability, so a successful probe still means the node is online.
 */
function nodeStatusForSystemdState(systemdState: string): NodeStatus {
  switch (systemdState.trim().toLowerCase()) {
    case "running":
    case "degraded":
    case "":
    case "unknown":
      return "online";
    default:
      return "degraded";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function commandEvidence(result: SshCommandResult): string {
  const sections: string[] = [];
  if (result.exitCode !== 0) sections.push(`[exit ${result.exitCode}]`);
  if (result.stdout.trim() !== "") sections.push(result.stdout.trimEnd());
  if (result.stderr.trim() !== "") sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (sections.length === 0) sections.push("(no output)");
  return sections.join("\n").slice(0, 16_000);
}

function remoteJobRoot(value: string): string {
  if (
    !value.startsWith("/")
    || value === "/"
    || value.endsWith("/")
    || value.includes("//")
    || value.includes("\0")
    || /[\r\n]/.test(value)
    || value.split("/").includes("..")
    || !/^[\x20-\x7e]+$/.test(value)
  ) {
    throw new Error("HUAWEI_JOB_ROOT_INVALID");
  }
  return value;
}

function assertTaskId(taskId: string): void {
  if (
    !SAFE_TASK_ID.test(taskId)
    || taskId === "."
    || taskId === ".."
  ) {
    throw new Error("HUAWEI_TASK_ID_INVALID");
  }
}

function outputLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  if (
    !Number.isInteger(limit)
    || limit < MIN_OUTPUT_LIMIT_BYTES
    || limit > MAX_OUTPUT_LIMIT_BYTES
  ) {
    throw new Error("HUAWEI_OUTPUT_LIMIT_INVALID");
  }
  return limit;
}

function boundedTaskOutput(value: string, limit: number): string {
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  const marker = "\n[truncated]";
  const markerBytes = Buffer.byteLength(marker, "utf8");
  let low = 0;
  let high = value.length;
  let best = "";
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") + markerBytes <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return `${best}${marker}`;
}

type RemoteTaskStatus =
  | "STARTING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

interface RemoteTaskInspection {
  status: RemoteTaskStatus;
  exitCode?: number;
  pid?: number;
  startedAt: string;
  finishedAt?: string;
  commandHash?: string;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function remoteTaskStatus(value: string | undefined): RemoteTaskStatus {
  if (
    value === "STARTING"
    || value === "RUNNING"
    || value === "COMPLETED"
    || value === "FAILED"
    || value === "CANCELLED"
  ) {
    return value;
  }
  throw new Error(`HUAWEI_TASK_STATUS_INVALID:${value ?? ""}`);
}

function decodeTaskOutput(
  encoded: string | undefined,
  remoteSize: number | undefined,
  limit: number,
): { value: string; truncated: boolean } {
  const decoded = Buffer.from(encoded ?? "", "base64").toString("utf8");
  const remoteWasTrimmed = (remoteSize ?? 0) > limit
    && Buffer.byteLength(decoded, "utf8") <= limit;
  const bounded = boundedTaskOutput(
    remoteWasTrimmed ? `${decoded}x` : decoded,
    limit,
  );
  return {
    value: bounded,
    truncated: bounded !== decoded || remoteWasTrimmed,
  };
}

function assertSshArgument(value: string, label: string): void {
  if (value.trim() === "" || value.includes("\0") || /[\r\n]/.test(value)) {
    throw new Error(`HUAWEI_SSH_INVALID_${label}`);
  }
}

export function buildHuaweiSshArguments(
  options: HuaweiSshArgumentOptions,
  command: string,
): string[] {
  assertSshArgument(options.host, "HOST");
  assertSshArgument(options.keyPath, "KEY_PATH");
  if (options.host.startsWith("-") || /\s/.test(options.host)) {
    throw new Error("HUAWEI_SSH_INVALID_HOST");
  }

  const args = [
    "-i", options.keyPath,
    "-o", "IdentitiesOnly=yes",
    "-o", "BatchMode=yes",
  ];
  if (options.knownHostsPath === undefined) {
    args.push("-o", "StrictHostKeyChecking=accept-new");
  } else {
    assertSshArgument(options.knownHostsPath, "KNOWN_HOSTS_PATH");
    args.push(
      "-o", "StrictHostKeyChecking=yes",
      "-o", `UserKnownHostsFile=${options.knownHostsPath}`,
      "-o", "GlobalKnownHostsFile=/dev/null",
      "-o", "UpdateHostKeys=no",
    );
  }
  args.push(
    "-o", "ConnectTimeout=12",
    options.host,
    // Do not start a login shell for provider scripts. Some managed images
    // run a logout hook that changes a successful `exit 0` into status 1
    // after the command has already emitted its result. Replacing the SSH
    // command shell also keeps the status owned by the script itself.
    `exec bash -c ${shellQuote(command)}`,
  );
  return args;
}

const SSH_FAILURE_CODE: Record<HuaweiSshFailureKind, string> = {
  "host-key-changed": "HUAWEI_SSH_HOST_KEY_CHANGED",
  "host-key-unverified": "HUAWEI_SSH_HOST_KEY_UNVERIFIED",
  "authentication-failed": "HUAWEI_SSH_AUTHENTICATION_FAILED",
  "key-error": "HUAWEI_SSH_KEY_ERROR",
  timeout: "HUAWEI_SSH_TIMEOUT",
  unreachable: "HUAWEI_SSH_UNREACHABLE",
  "ssh-unavailable": "HUAWEI_SSH_UNAVAILABLE",
  "command-failed": "HUAWEI_SSH_COMMAND_FAILED",
};

export function classifyHuaweiSshFailure(
  result: SshCommandResult,
): HuaweiSshFailureKind | undefined {
  if (result.exitCode === 0) return undefined;
  if (result.failureKind !== undefined) return result.failureKind;

  const detail = `${result.stderr}\n${result.errorCode ?? ""}`.toLowerCase();
  const errorCode = result.errorCode?.toUpperCase();
  if (errorCode === "ENOENT" || errorCode === "EACCES" || errorCode === "EPERM") {
    return "ssh-unavailable";
  }
  if (
    detail.includes("enoent")
    || detail.includes("ssh: not found")
    || detail.includes("spawn")
  ) {
    return "ssh-unavailable";
  }
  if (errorCode === "ETIMEDOUT") return "timeout";

  const sshProcessFailure = result.errorCode !== undefined
    || result.exitCode === 124
    || result.exitCode === 255;
  if (!sshProcessFailure) return "command-failed";

  if (
    detail.includes("remote host identification has changed")
    || detail.includes("host key has changed")
    || detail.includes("host key mismatch")
  ) {
    return "host-key-changed";
  }
  if (
    detail.includes("host key verification failed")
    || detail.includes("no host key is known")
    || (detail.includes("known_hosts") && detail.includes("not found"))
  ) {
    return "host-key-unverified";
  }
  if (
    detail.includes("permission denied")
    || detail.includes("authentication failed")
    || detail.includes("too many authentication failures")
  ) {
    return "authentication-failed";
  }
  if (
    detail.includes("load key")
    || detail.includes("bad permissions")
    || detail.includes("unprotected private key file")
    || detail.includes("no such identity")
    || detail.includes("identity file")
    || detail.includes("invalid format")
  ) {
    return "key-error";
  }
  if (
    detail.includes("connection refused")
    || detail.includes("connection reset")
    || detail.includes("connection timed out")
    || detail.includes("no route to host")
    || detail.includes("network is unreachable")
    || detail.includes("connection closed")
    || detail.includes("connection aborted")
    || detail.includes("broken pipe")
    || detail.includes("kex_exchange_identification")
    || detail.includes("could not resolve hostname")
    || detail.includes("name or service not known")
  ) {
    return "unreachable";
  }
  if (
    detail.includes("timed out")
    || detail.includes("timeout")
  ) {
    return "timeout";
  }
  return "command-failed";
}

function sshFailureError(result: SshCommandResult, fallback: string): HuaweiSshError {
  const kind = classifyHuaweiSshFailure(result) ?? "command-failed";
  const detail = result.stderr.trim()
    || (result.errorCode === undefined ? "" : `exit ${result.exitCode} (${result.errorCode})`)
    || fallback;
  return new HuaweiSshError(kind, SSH_FAILURE_CODE[kind], detail.slice(0, 4_000));
}

export function createHuaweiSshRunner(
  options: Pick<
    HuaweiSshProviderOptions,
    "host" | "keyPath" | "knownHostsPath" | "sshPath" | "timeoutMs"
  >,
): SshCommandRunner {
  const sshPath = options.sshPath
    ?? (process.platform === "win32" ? "C:\\Windows\\System32\\OpenSSH\\ssh.exe" : "ssh");
  return async (command) => {
    const args = buildHuaweiSshArguments(options, command);
    return await new Promise<SshCommandResult>((resolve) => {
      execFile(
        sshPath,
        args,
        {
          encoding: "utf8",
          timeout: options.timeoutMs ?? 30_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          const rawErrorCode = error !== null
            && typeof error === "object"
            && "code" in error
            && (typeof error.code === "number" || typeof error.code === "string")
            ? error.code
            : undefined;
          const errorCode = typeof rawErrorCode === "string"
            ? rawErrorCode
            : undefined;
          const timedOut = error !== null
            && typeof error === "object"
            && (
              ("killed" in error && error.killed === true)
              || ("signal" in error && error.signal !== null)
              || errorCode === "ETIMEDOUT"
            );
          const normalizedErrorCode = timedOut ? "ETIMEDOUT" : errorCode;
          const exitCode = error === null
            ? 0
            : timedOut
              ? 124
              : typeof rawErrorCode === "number"
                ? rawErrorCode
                : errorCode === "ENOENT"
                  ? 127
                  : 1;
          const normalizedStderr = typeof stderr === "string" ? stderr : String(stderr);
          const result: SshCommandResult = {
            stdout: typeof stdout === "string" ? stdout : String(stdout),
            stderr: error === null
              ? normalizedStderr
              : normalizedStderr.trim() === "" && error instanceof Error
                ? error.message
                : normalizedStderr,
            exitCode,
            ...(normalizedErrorCode === undefined ? {} : { errorCode: normalizedErrorCode }),
          };
          const failureKind = classifyHuaweiSshFailure(result);
          resolve({
            ...result,
            ...(failureKind === undefined
              ? {}
              : { failureKind }),
          });
        },
      );
    });
  };
}

// Linux stat's comm may contain spaces and ')' characters. Strip through the
// final ') ' before splitting fields 3 onward; never use awk '$22' on raw stat.
const PROCESS_IDENTITY_SCRIPT = `
read_process_identity() {
  current_pid=""
  current_pid_starttime=""
  current_session_id=""
  current_process_group_id=""
  stat_line=$(cat -- "/proc/$pid/stat" 2>/dev/null || true)
  [ -n "$stat_line" ] || return 1
  current_pid=\${stat_line%% *}
  stat_fields=\${stat_line##*) }
  [ "$stat_fields" != "$stat_line" ] || return 1
  set -f
  set -- $stat_fields
  [ "$#" -ge 20 ] || return 1
  [ "$1" != Z ] && [ "$1" != X ] || return 1
  current_process_group_id=$3
  current_session_id=$4
  current_pid_starttime=\${20}
}
load_identity() {
  pid=$(read_file "$job_dir/pid")
  boot_id=$(read_file "$job_dir/boot_id")
  pid_starttime=$(read_file "$job_dir/pid_starttime")
  session_id=$(read_file "$job_dir/session_id")
  process_group_id=$(read_file "$job_dir/process_group_id")
}
verify_identity() {
  lost_reason=""
  case "$pid:$pid_starttime:$session_id:$process_group_id" in *[!0-9:]*|:*|*::*|*:) lost_reason=identity_missing; return 1 ;; esac
  case "$boot_id" in ""|*[!a-fA-F0-9-]*) lost_reason=identity_missing; return 1 ;; esac
  if [ "$pid" -le 1 ] || [ "$session_id" != "$pid" ] || [ "$process_group_id" != "$pid" ]; then
    lost_reason=session_mismatch; return 1
  fi
  current_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  if [ -z "$current_boot_id" ] || [ "$current_boot_id" != "$boot_id" ]; then
    lost_reason=boot_id_mismatch; return 1
  fi
  if ! read_process_identity || [ "$current_pid" != "$pid" ]; then
    lost_reason=process_missing; return 1
  fi
  if [ "$current_pid_starttime" != "$pid_starttime" ]; then
    lost_reason=pid_starttime_mismatch; return 1
  fi
  if [ "$current_session_id" != "$session_id" ] || [ "$current_process_group_id" != "$process_group_id" ]; then
    lost_reason=session_mismatch; return 1
  fi
}
`;

const JOB_WORKER_SCRIPT = [
  "set +e",
  // Catch TERM in the supervisor before publishing its identity. A caught
  // handler resets to the default in exec'd commands, while this shell remains
  // an identity anchor when a child ignores TERM until verified group KILL.
  "trap ':' TERM",
  "job_dir=$1",
  "output_limit=$2",
  "execution_workspace_id=$3",
  "execution_source_revision=$4",
  "execution_source_digest=$5",
  "IFS= read -r command_b64 <&3 || exit 125",
  "exec 3<&-",
  "command=$(printf '%s' \"$command_b64\" | base64 -d) || exit 125",
  "unset command_b64",
  ": > \"$job_dir/stdout.part\"",
  ": > \"$job_dir/stderr.part\"",
  "write_atomic() {",
  "  target=$1",
  "  value=$2",
  "  tmp=\"$target.tmp.$$\"",
  "  printf '%s\\n' \"$value\" > \"$tmp\"",
  "  sync -- \"$tmp\"",
  "  mv -f -- \"$tmp\" \"$target\"",
  "}",
  PROCESS_IDENTITY_SCRIPT,
  'pid=$$',
  'boot_id=$(cat -- /proc/sys/kernel/random/boot_id) || exit 125',
  'read_process_identity || exit 125',
  'case "$boot_id:$current_pid_starttime" in *[!a-fA-F0-9:-]*|:*|*:) exit 125 ;; esac',
  '[ "$current_pid" = "$pid" ] && [ "$current_session_id" = "$pid" ] && [ "$current_process_group_id" = "$pid" ] || exit 125',
  'write_atomic "$job_dir/boot_id" "$boot_id" || exit 125',
  'write_atomic "$job_dir/pid_starttime" "$current_pid_starttime" || exit 125',
  'write_atomic "$job_dir/session_id" "$current_session_id" || exit 125',
  'write_atomic "$job_dir/process_group_id" "$current_process_group_id" || exit 125',
  'write_atomic "$job_dir/pid" "$pid" || exit 125',
  "write_atomic \"$job_dir/status\" RUNNING",
  "limit_stream() {",
  "  limit=$1",
  "  path=$2",
  "  total_path=$3",
  "  if command -v python3 >/dev/null 2>&1; then",
  // Two defects made the total an EOF-only artifact here.
  // (1) BufferedReader.read(n) on a pipe keeps issuing raw
  // reads until n bytes accumulate or EOF, so a producer
  // that writes and then holds (or is cancelled) left its
  // bytes sitting in the buffer unprocessed; read1 returns
  // after one raw read with whatever is available.
  // (2) The tmp/replace lines sat at column 0 — outside the
  // while loop — so the total was persisted only after the
  // loop ended at EOF, never per chunk. Every line of the
  // loop body now carries the one-space indent, and the
  // total is persisted BEFORE the capped bytes are
  // appended, so a kill anywhere in an iteration can never
  // leave the total behind the stored output.
  "    python3 -c 'import sys; limit=int(sys.argv[1]); out=open(sys.argv[2], \"wb\", buffering=0); total=0",
  "while True:",
  " chunk=sys.stdin.buffer.read1(65536)",
  " if not chunk: break",
  " start=total",
  " total += len(chunk)",
  " tmp=open(sys.argv[3] + \".tmp\", \"w\"); tmp.write(str(total) + \"\\n\"); tmp.close()",
  " import os; os.replace(sys.argv[3] + \".tmp\", sys.argv[3])",
  " if start < limit: out.write(chunk[:limit-start])",
  "if total == 0:",
  " tmp=open(sys.argv[3] + \".tmp\", \"w\"); tmp.write(\"0\\n\"); tmp.close()",
  " import os; os.replace(sys.argv[3] + \".tmp\", sys.argv[3])' \"$limit\" \"$path\" \"$total_path\"",
  "  else",
  // No-python3 fallback, chunked the same way: one dd block
  // is one raw read on a pipe (no fill-until-count loop like
  // head -c), the running total is replaced atomically per
  // chunk BEFORE the capped slice is appended, so TERM/KILL
  // at any moment leaves a true, parseable total behind.
  "    total=0",
  "    kept=0",
  "    chunk_path=\"$total_path.chunk\"",
  "    while :; do",
  "      dd bs=65536 count=1 of=\"$chunk_path\" 2>/dev/null || return 1",
  "      n=$(wc -c < \"$chunk_path\") || return 1",
  "      if [ \"$n\" -eq 0 ]; then break; fi",
  "      total=$((total + n))",
  "      printf '%s\\n' \"$total\" > \"$total_path.tmp.$$\" || return 1",
  "      mv -f -- \"$total_path.tmp.$$\" \"$total_path\" || return 1",
  "      room=$((limit - kept))",
  "      take=$n",
  "      if [ \"$take\" -gt \"$room\" ]; then take=$room; fi",
  "      if [ \"$take\" -gt 0 ]; then head -c \"$take\" -- \"$chunk_path\" >> \"$path\" || return 1; kept=$((kept + take)); fi",
  "    done",
  '    if [ "$total" -eq 0 ]; then write_atomic "$total_path" 0 || return 1; fi',
  "    rm -f -- \"$chunk_path\"",
  "  fi",
  "}",
  "stdout_pipe=\"$job_dir/stdout.pipe\"",
  "stderr_pipe=\"$job_dir/stderr.pipe\"",
  "rm -f -- \"$stdout_pipe\" \"$stderr_pipe\"",
  "mkfifo -- \"$stdout_pipe\" \"$stderr_pipe\" || exit 125",
  "limit_stream \"$output_limit\" \"$job_dir/stdout.part\" \"$job_dir/stdout.total\" < \"$stdout_pipe\" &",
  "stdout_writer=$!",
  "limit_stream \"$output_limit\" \"$job_dir/stderr.part\" \"$job_dir/stderr.total\" < \"$stderr_pipe\" &",
  "stderr_writer=$!",
  'command_digest=$(printf "%s" "$command" | sha256sum) || command_digest=""',
  'command_digest=${command_digest%% *}',
  'if [ -n "$execution_workspace_id" ]; then',
  '  workspace_dir="$job_dir/workspace"',
  '  [ -d "$workspace_dir" ] && [ ! -L "$workspace_dir" ] || exit 125',
  '  workspace_path=$(cd -- "$workspace_dir" && pwd -P) || exit 125',
  '  cd -- "$workspace_path" || exit 125',
  '  export FUSION_ATTEMPT_WORKSPACE="$workspace_path"',
  '  export FUSION_ATTEMPT_ID="$execution_workspace_id"',
  '  export FUSION_DSH_SOURCE_REVISION="$execution_source_revision"',
  '  export FUSION_DSH_SOURCE_SHA256="$execution_source_digest"',
  'fi',
  // The worker command is already bounded by Fusion's allowlist. Keep it in
  // a non-login shell so a remote profile/logout hook cannot rewrite its
  // terminal status after the command has emitted its output.
  "bash -c \"$command\" > \"$stdout_pipe\" 2> \"$stderr_pipe\"",
  "exit_code=$?",
  'capture_ok=1',
  'wait "$stdout_writer" || capture_ok=0',
  'wait "$stderr_writer" || capture_ok=0',
  "rm -f -- \"$stdout_pipe\" \"$stderr_pipe\"",
  // Serialize terminal publication with cancellation, after command children
  // exit so they cannot retain the lock descriptor.
  'exec 9>"$job_dir/state.lock"',
  'flock -x -w 5 9 || exit 125',
  'if [ "$(cat -- "$job_dir/status")" = CANCELLED ]; then exit 0; fi',
  'sync -- "$job_dir/stdout.part" "$job_dir/stderr.part" || capture_ok=0',
  'cp -p -- "$job_dir/stdout.part" "$job_dir/stdout" || capture_ok=0',
  'cp -p -- "$job_dir/stderr.part" "$job_dir/stderr" || capture_ok=0',
  'sync -- "$job_dir/stdout" "$job_dir/stderr" || capture_ok=0',
  // Publish a capture marker only after both streams have been read to EOF and copied.
  'if [ "${capture_ok:-0}" = 1 ] && [ -n "$command_digest" ]; then',
  '  write_atomic "$job_dir/output.complete" "$command_digest"',
  'fi',
  "finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  // A request alone is not a confirmed cancellation. The canceller publishes
  // CANCELLED only after observing that the process group has stopped.
  "if [ \"$exit_code\" -eq 0 ]; then",
  "  final_status=COMPLETED",
  "else",
  "  final_status=FAILED",
  "fi",
  "write_atomic \"$job_dir/exit\" \"$exit_code\"",
  "write_atomic \"$job_dir/finished_at\" \"$finished_at\"",
  "write_atomic \"$job_dir/status\" \"$final_status\"",
  "exit 0",
].join("\n");

function startJobCommand(
  jobDirectory: string,
  taskId: string,
  command: string,
  commandHash: string,
  limit: number,
  idempotencyKey?: string,
  requestFingerprint?: string,
  executionWorkspace?: FleetDispatchInput["executionWorkspace"],
): string {
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  return [
    "set -eu",
    "# HUAWEI_JOB_START",
    `job_dir=${shellQuote(jobDirectory)}`,
    `task_id=${shellQuote(taskId)}`,
    `output_limit=${limit}`,
    `command_sha256=${shellQuote(commandHash)}`,
    `idempotency_key=${shellQuote(idempotencyKey ?? "")}`,
    `request_sha256=${shellQuote(requestFingerprint ?? "")}`,
    `execution_workspace_id=${shellQuote(executionWorkspace?.id ?? "")}`,
    `execution_source_revision=${shellQuote(executionWorkspace?.sourceRevision ?? "")}`,
    `execution_source_digest=${shellQuote(executionWorkspace?.sourceDigest ?? "")}`,
    `command_b64=${shellQuote(encodedCommand)}`,
    `for tool in ${HUAWEI_JOB_REQUIRED_TOOLS.join(" ")}; do`,
    '  if ! command -v "$tool" >/dev/null 2>&1; then',
    "    printf 'HUAWEI_JOB_TOOL_UNAVAILABLE:%s\\n' \"$tool\" >&2",
    "    exit 127",
    "  fi",
    "done",
    'if [ -n "$execution_workspace_id" ] && ! command -v python3 >/dev/null 2>&1; then',
    "  printf 'HUAWEI_MATERIAL_READER_UNAVAILABLE\\n' >&2",
    "  exit 127",
    "fi",
    "umask 077",
    'mkdir -p -- "$job_dir"',
    'chmod 700 -- "$job_dir"',
    'if [ -e "$job_dir/status" ]; then',
    "  printf 'HUAWEI_JOB_ALREADY_EXISTS\\n' >&2",
    "  exit 1",
    "fi",
    "write_atomic() {",
    "  target=$1",
    "  value=$2",
    "  tmp=\"$target.tmp.$$\"",
    "  printf '%s\\n' \"$value\" > \"$tmp\"",
    "  sync -- \"$tmp\"",
    "  mv -f -- \"$tmp\" \"$target\"",
    "}",
    'write_atomic "$job_dir/task_id" "$task_id"',
    'write_atomic "$job_dir/command.sha256" "$command_sha256"',
    'if [ -n "$idempotency_key" ]; then write_atomic "$job_dir/idempotency.key" "$idempotency_key"; fi',
    'if [ -n "$request_sha256" ]; then write_atomic "$job_dir/request.sha256" "$request_sha256"; fi',
    'write_atomic "$job_dir/output.limit" "$output_limit"',
    'if [ -n "$execution_workspace_id" ]; then',
    '  case "$execution_workspace_id" in *[!A-Za-z0-9._:-]*) exit 2 ;; esac',
    '  case "$execution_source_revision" in ""|*[!A-Za-z0-9._:-]*) exit 2 ;; esac',
    '  case "$execution_source_digest" in *[!a-f0-9]*) exit 2 ;; esac',
    '  [ "${#execution_source_digest}" -eq 64 ] || exit 2',
    '  workspace_dir="$job_dir/workspace"',
    '  [ ! -L "$workspace_dir" ] || exit 2',
    '  mkdir -m 700 -- "$workspace_dir"',
    '  write_atomic "$job_dir/workspace.id" "$execution_workspace_id"',
    '  write_atomic "$job_dir/source.revision" "$execution_source_revision"',
    '  write_atomic "$job_dir/source.sha256" "$execution_source_digest"',
    'fi',
    'write_atomic "$job_dir/started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    // The status file is the start commit point, published only after
    // the full manifest above; inspect treats a directory without one
    // as not found (an uncommitted start whose command never ran).
    'write_atomic "$job_dir/status" STARTING',
    "export -f write_atomic",
    "export job_dir output_limit",
    "nohup setsid bash -s -- \"$job_dir\" \"$output_limit\" \"$execution_workspace_id\" \"$execution_source_revision\" \"$execution_source_digest\" 3<<<\"$command_b64\" >/dev/null 2>&1 <<'HUAWEI_JOB_WORKER' &",
    JOB_WORKER_SCRIPT,
    "HUAWEI_JOB_WORKER",
    "i=0",
    'while [ "$i" -lt 100 ]; do',
    '  if [ -s "$job_dir/pid" ] && [ -s "$job_dir/boot_id" ] && [ -s "$job_dir/pid_starttime" ] && [ -s "$job_dir/session_id" ] && [ -s "$job_dir/process_group_id" ]; then',
    '    current_status=$(cat -- "$job_dir/status" 2>/dev/null || true)',
    '    if [ "$current_status" != "STARTING" ]; then break; fi',
    "  fi",
    '  sleep 0.05',
    '  i=$((i + 1))',
    "done",
    'if [ ! -s "$job_dir/pid" ]; then',
    '  write_atomic "$job_dir/status" FAILED',
    "  printf 'HUAWEI_JOB_START_FAILED\\n' >&2",
    "  exit 1",
    "fi",
    'current_status=$(cat -- "$job_dir/status" 2>/dev/null || true)',
    'case "$current_status" in RUNNING|COMPLETED|FAILED|CANCELLED) ;; *)',
    "  printf 'HUAWEI_JOB_START_NOT_READY\\n' >&2",
    "  exit 1",
    "  ;;",
    "esac",
    "printf 'STATUS=RUNNING\\n'",
    "printf 'PID=%s\\n' \"$(cat \"$job_dir/pid\")\"",
    "printf 'BOOT_ID=%s\\n' \"$(cat \"$job_dir/boot_id\")\"",
    "printf 'PID_STARTTIME=%s\\n' \"$(cat \"$job_dir/pid_starttime\")\"",
    "printf 'SESSION_ID=%s\\n' \"$(cat \"$job_dir/session_id\")\"",
    "printf 'PROCESS_GROUP_ID=%s\\n' \"$(cat \"$job_dir/process_group_id\")\"",
    "printf 'STARTED_AT=%s\\n' \"$(cat \"$job_dir/started_at\")\"",
  ].join("\n");
}

function inspectJobCommand(
  jobDirectory: string,
  taskId: string,
  limit: number,
): string {
  return [
    "set -eu",
    "# HUAWEI_JOB_INSPECT",
    `job_dir=${shellQuote(jobDirectory)}`,
    `task_id=${shellQuote(taskId)}`,
    `output_limit=${limit}`,
    'if [ ! -d "$job_dir" ]; then',
    "  printf 'EXISTS=0\\n'",
    "  exit 0",
    "fi",
    "read_file() {",
    '  if [ -f "$1" ]; then cat -- "$1"; fi',
    "}",
    PROCESS_IDENTITY_SCRIPT,
    'exec 9>"$job_dir/state.lock"',
    'flock -s -w 5 9',
    'status=$(read_file "$job_dir/status")',
    'if [ -z "$status" ]; then',
    // No committed status: a start that crashed before its commit
    // point. Its command never ran, so report a lookup miss.
    "  printf 'EXISTS=0\\n'",
    '  exit 0',
    'fi',
    'load_identity',
    'lost_reason=""',
    'case "$status" in STARTING|RUNNING)',
    '  if ! verify_identity; then status=FAILED; fi ;;',
    'esac',
    'exit_code=$(read_file "$job_dir/exit")',
    'started_at=$(read_file "$job_dir/started_at")',
    'finished_at=$(read_file "$job_dir/finished_at")',
    'command_sha256=$(read_file "$job_dir/command.sha256")',
    'stdout_file="$job_dir/stdout"',
    'if [ ! -f "$stdout_file" ]; then stdout_file="$job_dir/stdout.part"; fi',
    'stderr_file="$job_dir/stderr"',
    'if [ ! -f "$stderr_file" ]; then stderr_file="$job_dir/stderr.part"; fi',
    'stdout_saved=0',
    'if [ -f "$stdout_file" ]; then stdout_saved=$(wc -c < "$stdout_file" | tr -d "[:space:]"); fi',
    'stderr_saved=0',
    'if [ -f "$stderr_file" ]; then stderr_saved=$(wc -c < "$stderr_file" | tr -d "[:space:]"); fi',
    'stdout_size=$stdout_saved',
    'stderr_size=$stderr_saved',
    // The worker records the true produced size next to the bounded
    // output (*.total); when present and numeric it is the size of
    // record, so truncation is reported from accounting, not
    // inferred from an already-truncated file.
    'stdout_total=$(read_file "$job_dir/stdout.total")',
    'case "$stdout_total" in ""|*[!0-9]*) ;; *) stdout_size=$stdout_total ;; esac',
    'stderr_total=$(read_file "$job_dir/stderr.total")',
    'case "$stderr_total" in ""|*[!0-9]*) ;; *) stderr_size=$stderr_total ;; esac',
    "printf 'EXISTS=1\\n'",
    "printf 'TASK_ID=%s\\n' \"$task_id\"",
    "printf 'WORKER_TASK_ID=%s\\n' \"$(read_file \"$job_dir/task_id\")\"",
    "printf 'STATUS=%s\\n' \"$status\"",
    "printf 'PID=%s\\n' \"$pid\"",
    "printf 'LOST_REASON=%s\\n' \"$lost_reason\"",
    "printf 'EXIT=%s\\n' \"$exit_code\"",
    "printf 'STARTED_AT=%s\\n' \"$started_at\"",
    "printf 'FINISHED_AT=%s\\n' \"$finished_at\"",
    "printf 'COMMAND_SHA256=%s\\n' \"$command_sha256\"",
    "printf 'IDEMPOTENCY_KEY=%s\\n' \"$(read_file \"$job_dir/idempotency.key\")\"",
    "printf 'REQUEST_SHA256=%s\\n' \"$(read_file \"$job_dir/request.sha256\")\"",
    "printf 'STDOUT_SIZE=%s\\n' \"$stdout_size\"",
    "printf 'STDOUT_TOTAL=%s\\n' \"$stdout_total\"",
    "printf 'STDOUT='",
    'stdout_read=0',
    'if [ -f "$stdout_file" ] && (set -o pipefail; head -c "$output_limit" -- "$stdout_file" | base64 -w0); then stdout_read=1; fi',
    "printf '\\n'",
    "printf 'STDERR_SIZE=%s\\n' \"$stderr_size\"",
    "printf 'STDERR_TOTAL=%s\\n' \"$stderr_total\"",
    "printf 'STDERR='",
    'stderr_read=0',
    'if [ -f "$stderr_file" ] && (set -o pipefail; head -c "$output_limit" -- "$stderr_file" | base64 -w0); then stderr_read=1; fi',
    "printf '\\n'",
    'capture_command_sha256=""',
    'if [ "$stdout_read:$stderr_read" = "1:1" ] \\',
    '  && [ "$stdout_file" = "$job_dir/stdout" ] && [ "$stderr_file" = "$job_dir/stderr" ] \\',
    '  && [ "$stdout_saved:$stderr_saved" = "$stdout_total:$stderr_total" ]; then',
    '  capture_command_sha256=$(read_file "$job_dir/output.complete")',
    'fi',
    "printf 'CAPTURE_COMMAND_SHA256=%s\\n' \"$capture_command_sha256\"",
  ].join("\n");
}

function readExecutionMaterialsCommand(
  jobDirectory: string,
  taskId: string,
  workspaceId: string,
  paths: readonly string[],
): string {
  return [
    "set -eu",
    "# HUAWEI_EXECUTION_MATERIAL_READ",
    `python3 - ${[jobDirectory, taskId, workspaceId, ...paths].map(shellQuote).join(" ")} <<'HUAWEI_MATERIAL_READER'`,
    "import base64, hashlib, os, stat, sys",
    "job_dir, task_id, workspace_id, *paths = sys.argv[1:]",
    "O_DIR = os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0) | getattr(os, 'O_NOFOLLOW', 0)",
    "O_FILE = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)",
    "def open_dir_path(path):",
    "    if not path.startswith('/') or any(part in ('.', '..') for part in path.split('/')): raise ValueError()",
    "    fd = os.open('/', O_DIR)",
    "    try:",
    "        for part in [part for part in path.split('/') if part]:",
    "            nxt = os.open(part, O_DIR, dir_fd=fd); os.close(fd); fd = nxt",
    "        return fd",
    "    except Exception:",
    "        os.close(fd); raise",
    "def read_small(dirfd, name, limit=256):",
    "    fd = os.open(name, O_FILE, dir_fd=dirfd)",
    "    try:",
    "        info = os.fstat(fd)",
    "        if not stat.S_ISREG(info.st_mode) or info.st_size > limit: raise ValueError()",
    "        data = os.read(fd, limit + 1)",
    "        if len(data) != info.st_size: raise ValueError()",
    "        return data.decode('utf-8').rstrip('\\n')",
    "    finally: os.close(fd)",
    "jobfd = open_dir_path(job_dir)",
    "try:",
    "    if read_small(jobfd, 'task_id') != task_id: raise ValueError()",
    "    if read_small(jobfd, 'status') not in ('COMPLETED', 'FAILED'): raise ValueError()",
    "    if read_small(jobfd, 'workspace.id') != workspace_id: raise ValueError()",
    "    revision = read_small(jobfd, 'source.revision')",
    "    source_digest = read_small(jobfd, 'source.sha256')",
    "    if not revision.isdigit() or len(revision) > 16 or len(source_digest) != 64 or any(c not in '0123456789abcdef' for c in source_digest): raise ValueError()",
    "    workspacefd = os.open('workspace', O_DIR, dir_fd=jobfd)",
    "    try:",
    "        workspace_path = os.readlink('/proc/self/fd/' + str(workspacefd))",
    "        if not workspace_path.startswith('/') or workspace_path.endswith(' (deleted)'): raise ValueError()",
    "        print('WORKSPACE_PATH=' + workspace_path)",
    "        print('WORKSPACE_ID=' + workspace_id)",
    "        print('SOURCE_REVISION=' + revision)",
    "        print('SOURCE_SHA256=' + source_digest)",
    "        print('MATERIAL_COUNT=' + str(len(paths)))",
    "        total = 0",
    "        for index, relative in enumerate(paths):",
    "            parts = relative.split('/')",
    "            if not relative or relative.startswith('/') or any(part in ('', '.', '..') for part in parts): raise ValueError()",
    "            parent = os.dup(workspacefd)",
    "            try:",
    "                for part in parts[:-1]:",
    "                    nxt = os.open(part, O_DIR, dir_fd=parent); os.close(parent); parent = nxt",
    "                fd = os.open(parts[-1], O_FILE, dir_fd=parent)",
    "                try:",
    "                    before = os.fstat(fd)",
    "                    if not stat.S_ISREG(before.st_mode) or before.st_size > 262144: raise ValueError()",
    "                    chunks=[]; remaining=262145",
    "                    while remaining:",
    "                        chunk=os.read(fd, min(65536, remaining))",
    "                        if not chunk: break",
    "                        chunks.append(chunk); remaining -= len(chunk)",
    "                    data=b''.join(chunks); after=os.fstat(fd)",
    "                    if len(data) != before.st_size or len(data) > 262144 or (before.st_ino, before.st_dev, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_dev, after.st_size, after.st_mtime_ns): raise ValueError()",
    "                finally: os.close(fd)",
    "            finally: os.close(parent)",
    "            total += len(data)",
    "            if total > 524288: raise ValueError()",
    "            print('MATERIAL_' + str(index) + '_PATH=' + relative)",
    "            print('MATERIAL_' + str(index) + '_BYTES=' + str(len(data)))",
    "            print('MATERIAL_' + str(index) + '_BASE64=' + base64.b64encode(data).decode('ascii'))",
    "    finally: os.close(workspacefd)",
    "finally: os.close(jobfd)",
    "HUAWEI_MATERIAL_READER",
  ].join("\n");
}

function cancelJobCommand(
  jobDirectory: string,
  taskId: string,
): string {
  return [
    "set -eu",
    "# HUAWEI_JOB_CANCEL",
    `job_dir=${shellQuote(jobDirectory)}`,
    `task_id=${shellQuote(taskId)}`,
    'if [ ! -d "$job_dir" ]; then',
    "  printf 'EXISTS=0\\n'",
    "  exit 0",
    "fi",
    "read_file() {",
    '  if [ -f "$1" ]; then cat -- "$1"; fi',
    "}",
    'write_atomic() {',
    '  target=$1',
    '  value=$2',
    '  tmp="$target.tmp.$$"',
    "  printf '%s\\n' \"$value\" > \"$tmp\"",
    '  sync -- "$tmp"',
    '  mv -f -- "$tmp" "$target"',
    "}",
    PROCESS_IDENTITY_SCRIPT,
    'exec 9>"$job_dir/state.lock"',
    'flock -x -w 5 9',
    'status=$(read_file "$job_dir/status")',
    'if [ "$status" = "CANCELLED" ]; then',
    "  printf 'CANCELLED=1\\nPREVIOUS_STATUS=CANCELLED\\n'",
    "  exit 0",
    "fi",
    'if [ "$status" = "COMPLETED" ] || [ "$status" = "FAILED" ]; then',
    "  printf 'CANCELLED=0\\nSTATUS=%s\\n' \"$status\"",
    "  exit 0",
    "fi",
    'case "$status" in STARTING|RUNNING) ;; *) printf "HUAWEI_TASK_STATUS_INVALID\\n" >&2; exit 1 ;; esac',
    'load_identity',
    'identity_lost() { printf "CANCELLED=0\\nSTATUS=FAILED\\nLOST_REASON=%s\\n" "$lost_reason"; exit 0; }',
    'cancel_unconfirmed() { printf "CANCELLED=0\\nSTATUS=RUNNING\\nERROR=CANCELLATION_UNCONFIRMED\\n"; exit 0; }',
    'group_alive() { kill -0 -- "-$pid" 2>/dev/null || read_process_identity; }',
    'verify_identity || identity_lost',
    'write_atomic "$job_dir/cancel.requested" 1',
    'verify_identity || identity_lost',
    'kill -TERM -- "-$pid" 2>/dev/null || cancel_unconfirmed',
    'i=0',
    'while [ "$i" -lt 20 ]; do',
    '  if ! group_alive; then break; fi',
    '  sleep 0.1',
    '  i=$((i + 1))',
    'done',
    'if group_alive; then',
    // A reused group must not receive KILL, even if TERM targeted the old job.
    '  verify_identity || identity_lost',
    '  kill -KILL -- "-$pid" 2>/dev/null || cancel_unconfirmed',
    '  i=0',
    '  while [ "$i" -lt 20 ]; do',
    '    if ! group_alive; then break; fi',
    '    sleep 0.1',
    '    i=$((i + 1))',
    '  done',
    'fi',
    'if group_alive; then cancel_unconfirmed; fi',
    'if [ ! -f "$job_dir/stdout" ] && [ -f "$job_dir/stdout.part" ]; then cp -p -- "$job_dir/stdout.part" "$job_dir/stdout"; fi',
    'if [ ! -f "$job_dir/stderr" ] && [ -f "$job_dir/stderr.part" ]; then cp -p -- "$job_dir/stderr.part" "$job_dir/stderr"; fi',
    'sync -- "$job_dir/stdout" "$job_dir/stderr" 2>/dev/null || true',
    'write_atomic "$job_dir/exit" 130',
    'write_atomic "$job_dir/finished_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"',
    'write_atomic "$job_dir/status" CANCELLED',
    "printf 'CANCELLED=1\\nPREVIOUS_STATUS=%s\\n' \"$status\"",
  ].join("\n");
}

export class HuaweiSshProvider implements FleetProvider {
  readonly id: string;
  readonly kind = "fleet" as const;
  private readonly host: string;
  private readonly nodeId: string;
  private readonly name: string;
  private readonly runCommand: SshCommandRunner;
  private readonly probeTimeoutMs: number;
  private readonly jobRoot: string;
  private readonly outputLimit: number;
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(options: HuaweiSshProviderOptions) {
    this.id = options.providerId?.trim() || "huawei-ssh";
    this.host = options.host;
    this.nodeId = options.nodeId ?? "huawei-hs-monitor-cn";
    this.name = options.name ?? "华为云 hs-monitor-cn";
    this.runCommand = options.run ?? createHuaweiSshRunner(options);
    this.probeTimeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0 ? options.timeoutMs! : 30_000;
    this.jobRoot = remoteJobRoot(options.jobRoot ?? DEFAULT_JOB_ROOT);
    this.outputLimit = outputLimit(options.outputLimitBytes);
  }

  async probeExecCapability(): Promise<ExecCapabilityObservation> {
    const checkedAt = Date.now();
    const parse = (stdout: string) => parseExecCapabilityProbe({ nodeId: this.nodeId, providerId: this.id, stdout, checkedAt, expectedTools: HUAWEI_JOB_REQUIRED_TOOLS });
    const failed = (): ExecCapabilityObservation => ({ ...parse(""), reasonCodes: ["EXEC_PROBE_FAILED"] });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.runCommand(execCapabilityProbeCommand(this.jobRoot, HUAWEI_JOB_REQUIRED_TOOLS)),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("EXEC_PROBE_TIMEOUT")), this.probeTimeoutMs); }),
      ]);
      if (result.exitCode !== 0) return failed();
      return parse(result.stdout);
    } catch {
      return failed();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async health(): Promise<ProviderStatus> {
    try {
      const nodes = await this.listNodes();
      const node = nodes[0];
      if (node === undefined) throw new Error("HUAWEI_NODE_NOT_REPORTED");
      return createProviderStatus({
        state: node.status === "online" ? "connected" : "degraded",
        message: `${node.name}: ${node.status}`,
      });
    } catch (error) {
      return createProviderStatus({
        state: "offline",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listNodes(): Promise<NodeRecord[]> {
    const result = await this.runCommand(NODE_PROBE_COMMAND);
    if (result.exitCode !== 0) {
      throw sshFailureError(result, `Huawei SSH exited ${result.exitCode}`);
    }
    const values = parseKeyValueLines(result.stdout);
    const failedUnits = finiteCount(values.FAILED);
    const host = values.HOST;
    const systemdState = values.SYSTEM;
    if (host === undefined || host === "" || systemdState === undefined || failedUnits === undefined) {
      const missing = [
        host === undefined || host === "" ? "HOST" : undefined,
        systemdState === undefined ? "SYSTEM" : undefined,
        failedUnits === undefined ? "FAILED" : undefined,
      ].filter((value): value is string => value !== undefined);
      throw new Error(`HUAWEI_PROBE_INCOMPLETE:${missing.join(",")}`);
    }
    const cpuPercent = finitePercentage(values.CPU);
    const memoryPercent = finitePercentage(values.MEM);
    // The probe succeeding is the reachability signal. Failed systemd units are
    // unrelated unit health, so they are reported instead of being folded into
    // the node status.
    return [{
      id: this.nodeId,
      externalId: this.host,
      providerId: this.id,
      name: this.name,
      platform: "linux",
      roles: ["worker"],
      status: nodeStatusForSystemdState(systemdState),
      transports: ["ssh"],
      capabilities: ["linux", "ssh", "monitor", "hindsight", "config", values.ARCH ?? "unknown"],
      configState: "unknown",
      lastHeartbeat: new Date().toISOString(),
      ...(cpuPercent === undefined ? {} : { cpuPercent }),
      ...(memoryPercent === undefined ? {} : { memoryPercent }),
      systemdState,
      failedUnits,
    }];
  }

  /**
   * The node this provider owns, reported without running a probe.
   *
   * The identity is fixed at construction time, so it stays available when
   * the host cannot be reached. A caller that keeps this node as offline
   * shows "the host is unreachable" rather than "the node is gone".
   */
  describeNodes(): NodeRecord[] {
    return [{
      id: this.nodeId,
      externalId: this.host,
      providerId: this.id,
      name: this.name,
      platform: "linux",
      roles: ["worker"],
      status: "offline",
      transports: ["ssh"],
      capabilities: ["linux", "ssh", "monitor", "hindsight", "config"],
      configState: "unknown",
    }];
  }

  async doctor(): Promise<{ node: NodeRecord; evidence: TaskEvidence[] }> {
    const [node] = await this.listNodes();
    if (node === undefined) throw new Error("HUAWEI_NODE_NOT_REPORTED");
    const result = await this.runCommand(DOCTOR_COMMAND);
    if (result.exitCode !== 0) {
      throw sshFailureError(result, `Huawei doctor exited ${result.exitCode}`);
    }
    return {
      node,
      evidence: [{
        kind: "command",
        label: "huawei-doctor",
        value: commandEvidence(result),
      }],
    };
  }

  async dispatch(input: FleetDispatchInput): Promise<TaskRecord> {
    if (!input.nodeIds.includes(this.nodeId)) {
      throw new Error(`HUAWEI_NODE_NOT_TARGETED:${input.nodeIds.join(",")}`);
    }
    const command = input.command === undefined
      ? "uname -a; uptime; free -m; df -h /"
      : input.command.trim();
    if (command === "") throw new Error("HUAWEI_COMMAND_EMPTY");
    if (command.includes("\0")) throw new Error("HUAWEI_COMMAND_INVALID");
    let taskId = `HUAWEI-${randomUUID()}`;
    if (input.taskId !== undefined) {
      assertTaskId(input.taskId);
      taskId = input.taskId;
    }
    const idempotencyKey = input.idempotencyKey?.trim();
    const requestFingerprint = input.dispatchFingerprint?.trim();
    const executionWorkspace = input.executionWorkspace;
    if (executionWorkspace !== undefined && (
      !SAFE_WORKSPACE_ID.test(executionWorkspace.id)
      || !/^\d{1,16}$/u.test(executionWorkspace.sourceRevision)
      || !/^[a-f0-9]{64}$/u.test(executionWorkspace.sourceDigest)
    )) throw new Error("HUAWEI_EXECUTION_WORKSPACE_INVALID");
    if ((idempotencyKey === undefined) !== (requestFingerprint === undefined)) {
      throw new Error("HUAWEI_TASK_IDEMPOTENCY_INVALID");
    }
    const commandHash = createHash("sha256").update(command, "utf8").digest("hex");
    const result = await this.runCommand(startJobCommand(
      this.jobDirectory(taskId),
      taskId,
      command,
      commandHash,
      this.outputLimit,
      idempotencyKey,
      requestFingerprint,
      executionWorkspace,
    ));
    if (result.exitCode !== 0) {
      throw sshFailureError(result, `Huawei job start exited ${result.exitCode}`);
    }
    const values = parseKeyValueLines(result.stdout);
    const pid = finiteCount(values.PID);
    if (
      values.STATUS !== "RUNNING"
      || values.STARTED_AT === undefined
      || values.STARTED_AT === ""
      || pid === undefined
      || pid <= 1
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(values.BOOT_ID ?? "")
      || !/^[0-9]+$/.test(values.PID_STARTTIME ?? "")
      || values.SESSION_ID !== String(pid)
      || values.PROCESS_GROUP_ID !== String(pid)
    ) {
      throw new Error("HUAWEI_TASK_START_INVALID");
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      goal: input.goal,
      targetNodeIds: [this.nodeId],
      transport: "ssh",
      status: "running",
      progress: 20,
      evidence: [{
        kind: "summary",
        label: `${taskId}:summary`,
        value: [
          "status=running",
          `pid=${pid}`,
          `bootId=${values.BOOT_ID}`,
          `pidStarttime=${values.PID_STARTTIME}`,
          `sessionId=${values.SESSION_ID}`,
          `processGroupId=${values.PROCESS_GROUP_ID}`,
          `jobDir=${this.jobDirectory(taskId)}`,
        ].join("\n"),
        sha256: commandHash,
      }],
      expectedEvidence: ["summary", "command", "log"],
      createdAt: values.STARTED_AT || now,
      updatedAt: now,
      ...(input.requestedByBotId === undefined
        ? {}
        : { requestedByBotId: input.requestedByBotId }),
      ...(idempotencyKey === undefined || requestFingerprint === undefined
        ? {}
        : { idempotencyKey, dispatchFingerprint: requestFingerprint }),
    };
    this.tasks.set(taskId, task);
    return task;
  }

  async inspect(taskId: string): Promise<TaskRecord> {
    assertTaskId(taskId);
    const result = await this.runCommand(inspectJobCommand(
      this.jobDirectory(taskId),
      taskId,
      this.outputLimit,
    ));
    if (result.exitCode !== 0) {
      throw sshFailureError(result, `Huawei job inspect exited ${result.exitCode}`);
    }
    const values = parseKeyValueLines(result.stdout);
    if (values.EXISTS === "0") throw new Error(`HUAWEI_TASK_NOT_FOUND:${taskId}`);
    if (values.EXISTS !== "1") throw new Error("HUAWEI_TASK_INSPECT_INVALID");

    const status = remoteTaskStatus(values.STATUS);
    const executionObservation = readWorkerExecutionObservation(result.stdout, taskId, this.nodeId, this.outputLimit);
    const stdout = decodeTaskOutput(
      values.STDOUT,
      finiteCount(values.STDOUT_SIZE),
      this.outputLimit,
    );
    const stderr = decodeTaskOutput(
      values.STDERR,
      finiteCount(values.STDERR_SIZE),
      this.outputLimit,
    );
    const startedAt = values.STARTED_AT === undefined || values.STARTED_AT === ""
      ? this.tasks.get(taskId)?.createdAt ?? new Date().toISOString()
      : values.STARTED_AT;
    const finishedAt = values.FINISHED_AT === undefined || values.FINISHED_AT === ""
      ? undefined
      : values.FINISHED_AT;
    const exitCode = finiteCount(values.EXIT);
    const existing = this.tasks.get(taskId);
    const taskStatus: TaskRecord["status"] = status === "STARTING" || status === "RUNNING"
      ? "running"
      : status === "COMPLETED"
        ? "completed"
        : status === "FAILED"
          ? "failed"
          : "cancelled";
    const progress = taskStatus === "running"
      ? 50
      : taskStatus === "failed"
        ? 0
        : 100;
    const evidence: TaskEvidence[] = [{
      kind: "summary",
      label: `${taskId}:summary`,
      value: [
        `status=${taskStatus}`,
        `exit=${exitCode === undefined ? "pending" : exitCode}`,
        `stdoutTruncated=${stdout.truncated}`,
        `stderrTruncated=${stderr.truncated}`,
        ...(values.LOST_REASON ? [`lostReason=${values.LOST_REASON}`] : []),
      ].join("\n"),
      ...(values.COMMAND_SHA256 === undefined || values.COMMAND_SHA256 === ""
        ? {}
        : { sha256: values.COMMAND_SHA256 }),
    }, {
      kind: "command",
      label: `${taskId}:stdout`,
      value: normalizeEvidenceValue(stdout.value),
    }, {
      kind: "log",
      label: `${taskId}:stderr`,
      value: normalizeEvidenceValue(stderr.value),
    }];
    const task: TaskRecord = {
      id: taskId,
      goal: existing?.goal ?? `Huawei SSH task ${taskId}`,
      targetNodeIds: [this.nodeId],
      transport: "ssh",
      status: taskStatus,
      progress,
      evidence,
      ...(executionObservation === undefined ? {} : { executionObservation }),
      expectedEvidence: ["summary", "command", "log"],
      createdAt: existing?.createdAt ?? startedAt,
      updatedAt: finishedAt ?? new Date().toISOString(),
      ...(existing?.requestedByBotId === undefined
        ? {}
        : { requestedByBotId: existing.requestedByBotId }),
      ...(values.IDEMPOTENCY_KEY === undefined || values.IDEMPOTENCY_KEY === ""
        ? {}
        : { idempotencyKey: values.IDEMPOTENCY_KEY }),
      ...(values.REQUEST_SHA256 === undefined || values.REQUEST_SHA256 === ""
        ? {}
        : { dispatchFingerprint: values.REQUEST_SHA256 }),
      ...(taskStatus === "failed"
        ? {
            error: values.LOST_REASON
              ? `HUAWEI_TASK_LOST:${values.LOST_REASON}`
              : `HUAWEI_TASK_FAILED:exit=${exitCode ?? "unknown"}${
              stderr.value === "" ? "" : `:${stderr.value.slice(0, 1_000)}`
            }`,
          }
        : {}),
    };
    this.tasks.set(taskId, task);
    return task;
  }

  async readExecutionMaterialFiles(
    taskId: string,
    workspaceId: string,
    paths: readonly string[],
  ): Promise<ExecutionMaterialWorkspaceFiles | undefined> {
    assertTaskId(taskId);
    if (!SAFE_WORKSPACE_ID.test(workspaceId) || paths.length === 0 || paths.length > 68
      || new Set(paths).size !== paths.length || !paths.every(validExecutionMaterialPath)) return undefined;
    const result = await this.runCommand(readExecutionMaterialsCommand(
      this.jobDirectory(taskId), taskId, workspaceId, paths,
    ));
    if (result.exitCode !== 0) return undefined;
    const materials = parseExecutionMaterialFiles(result.stdout, workspaceId, paths);
    const expectedWorkspacePath = posix.normalize(`${this.jobDirectory(taskId)}/workspace`);
    return materials?.workspacePath === expectedWorkspacePath ? materials : undefined;
  }

  async cancel(taskId: string): Promise<void> {
    assertTaskId(taskId);
    const result = await this.runCommand(cancelJobCommand(
      this.jobDirectory(taskId),
      taskId,
    ));
    if (result.exitCode !== 0) {
      throw sshFailureError(result, `Huawei job cancel exited ${result.exitCode}`);
    }
    const values = parseKeyValueLines(result.stdout);
    if (values.EXISTS === "0") throw new Error(`HUAWEI_TASK_NOT_FOUND:${taskId}`);
    if (values.CANCELLED !== "0" && values.CANCELLED !== "1") {
      throw new Error("HUAWEI_TASK_CANCEL_INVALID");
    }
    if (values.CANCELLED === "0") {
      if (values.LOST_REASON) throw new Error(`HUAWEI_TASK_LOST:${values.LOST_REASON}`);
      if (values.ERROR) throw new Error(`HUAWEI_TASK_CANCEL_FAILED:${values.ERROR}`);
      throw new Error(`HUAWEI_TASK_ALREADY_TERMINAL:${values.STATUS ?? "unknown"}`);
    }
    if (values.CANCELLED === "1") {
      const existing = this.tasks.get(taskId);
      if (existing !== undefined) {
        this.tasks.set(taskId, {
          ...existing,
          status: "cancelled",
          progress: 100,
          updatedAt: new Date().toISOString(),
        });
      }
    }
  }

  private jobDirectory(taskId: string): string {
    assertTaskId(taskId);
    return `${this.jobRoot}/${taskId}`;
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}
