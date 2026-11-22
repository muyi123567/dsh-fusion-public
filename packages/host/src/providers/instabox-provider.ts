import { createHash, randomUUID } from "node:crypto";
import type {
  ExecCapabilityObservation,
  NodeRecord,
  ProviderStatus,
  TaskEvidence,
  TaskRecord,
} from "@dsh-fusion/core";
import { createProviderStatus } from "@dsh-fusion/core";
import type { FleetDispatchInput, FleetProvider } from "./fleet-provider.js";
import { normalizeEvidenceValue } from "../tasks/evidence.js";
import { readWorkerExecutionObservation } from "./worker-execution.js";
import { execCapabilityProbeCommand, parseExecCapabilityProbe } from "./exec-capability-probe.js";

export interface InstaboxMachine {
  id: string;
  name: string;
  state: string;
  runtime?: {
    ready?: boolean;
  };
}

export interface InstaboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface InstaboxProviderOptions {
  apiKey: string;
  machineName: string;
  apiBaseUrl?: string;
  providerId?: string;
  nodeId?: string;
  name?: string;
  timeoutMs?: number;
  jobRoot?: string;
  outputLimitBytes?: number;
  fetch?: typeof globalThis.fetch;
}

const DEFAULT_API_BASE_URL = "https://api.instabox.sh";
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_JOB_ROOT = "/tmp/dsh-fusion-instabox-jobs";
const DEFAULT_OUTPUT_LIMIT_BYTES = 64 * 1024;
const MIN_OUTPUT_LIMIT_BYTES = 16;
const MAX_OUTPUT_LIMIT_BYTES = 512 * 1024;
const SAFE_TASK_ID = /^INSTABOX-[A-Za-z0-9-]+$/;
const MAX_TASK_ID_LENGTH = 128;
const STATE_LOCK_STALE_SECONDS = 10;
// A committed STARTING without a worker pid older than this is an
// orphaned start, not a job still starting (the owning start marks the
// job FAILED itself within ~5 seconds when it stays alive).
const STARTING_WITHOUT_WORKER_GRACE_SECONDS = 60;
const START_RECOVERY_ATTEMPTS = 3;
const START_RECOVERY_DELAY_MS = 200;
const INSTABOX_JOB_TOOLS = [
  "base64", "sha256sum", "sync", "date", "mkdir", "chmod", "cp", "mv", "rm",
  "sleep", "cat", "nohup", "setsid", "bash", "ps", "head", "wc", "tr", "awk", "dirname", "mkfifo",
] as const;

type RemoteTaskStatus =
  | "STARTING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "LOST";

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/u, "");
}

function safeNodeSuffix(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized === "" ? "machine" : normalized.slice(0, 80);
}

export function defaultInstaboxNodeId(machineName: string): string {
  return `instabox-${safeNodeSuffix(machineName)}`;
}

function parseKeyValueLines(stdout: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key)) continue;
    result[key] = line.slice(separator + 1).trim();
  }
  return result;
}

function finiteCount(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function commandEvidence(result: InstaboxExecResult): string {
  const sections: string[] = [];
  if (result.exitCode !== 0) sections.push(`[exit ${result.exitCode}]`);
  if (result.stdout.trim() !== "") sections.push(result.stdout.trimEnd());
  if (result.stderr.trim() !== "") sections.push(`[stderr]\n${result.stderr.trimEnd()}`);
  if (sections.length === 0) sections.push("(no output)");
  return sections.join("\n").slice(0, 16_000);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const JOB_PATH_GUARD_SCRIPT = `
assert_no_symlink_components() {
  path=$1
  while :; do
    if [ -L "$path" ]; then
      printf 'INSTABOX_JOB_PATH_SYMLINK:%s\\n' "$path" >&2
      return 1
    fi
    parent=$(dirname -- "$path")
    if [ "$parent" = "$path" ]; then break; fi
    path=$parent
  done
}
job_root=$(dirname -- "$job_dir")
assert_no_symlink_components "$job_root" || exit 2
`.trim();

function remoteJobRoot(value: string): string {
  if (
    !value.startsWith("/")
    || value === "/"
    || value.endsWith("/")
    || value.includes("//")
    || value.includes("\0")
    || /[\r\n]/u.test(value)
    || value.split("/").includes("..")
    || !/^[\x20-\x7e]+$/u.test(value)
  ) {
    throw new Error("INSTABOX_JOB_ROOT_INVALID");
  }
  return value;
}

function assertTaskId(taskId: string): void {
  if (
    taskId.length > MAX_TASK_ID_LENGTH
    || !SAFE_TASK_ID.test(taskId)
  ) {
    throw new Error("INSTABOX_TASK_ID_INVALID");
  }
}

function outputLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_OUTPUT_LIMIT_BYTES;
  if (
    !Number.isInteger(limit)
    || limit < MIN_OUTPUT_LIMIT_BYTES
    || limit > MAX_OUTPUT_LIMIT_BYTES
  ) {
    throw new Error("INSTABOX_OUTPUT_LIMIT_INVALID");
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

function remoteTaskStatus(value: string | undefined): RemoteTaskStatus {
  if (
    value === "STARTING"
    || value === "RUNNING"
    || value === "COMPLETED"
    || value === "FAILED"
    || value === "CANCELLED"
    || value === "LOST"
  ) {
    return value;
  }
  throw new Error(`INSTABOX_TASK_STATUS_INVALID:${value ?? ""}`);
}

function lostIdentityReason(
  values: Record<string, string>,
  status: RemoteTaskStatus,
  pid: number | undefined,
): string | undefined {
  if (status === "LOST") {
    return values.LOST_REASON === undefined || values.LOST_REASON === ""
      ? "identity_mismatch"
      : values.LOST_REASON;
  }
  if (status !== "RUNNING") return undefined;
  if (
    values.BOOT_ID === undefined
    || values.BOOT_ID === ""
    || values.CURRENT_BOOT_ID === undefined
    || values.CURRENT_BOOT_ID !== values.BOOT_ID
  ) {
    return "boot_id_mismatch";
  }
  if (
    pid === undefined
    || pid <= 1
    || values.CURRENT_PID === undefined
    || values.CURRENT_PID !== String(pid)
  ) {
    return "pid_mismatch";
  }
  if (
    values.PID_STARTTIME === undefined
    || values.PID_STARTTIME === ""
    || values.CURRENT_PID_STARTTIME === undefined
    || values.CURRENT_PID_STARTTIME !== values.PID_STARTTIME
  ) {
    return "pid_starttime_mismatch";
  }
  return undefined;
}

function assertionMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function decodeTaskOutput(
  encoded: string | undefined,
  remoteSize: number | undefined,
  limit: number,
): { value: string; truncated: boolean } {
  const value = encoded ?? "";
  if (
    value !== ""
    && (
      value.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
    )
  ) {
    throw new Error("INSTABOX_TASK_OUTPUT_INVALID");
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
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

const JOB_WORKER_SCRIPT = `
set -u
job_dir=$1
output_limit=\${2:-}
if [ -z "$output_limit" ] && [ -f "$job_dir/output.limit" ]; then
  output_limit=$(tr -d "[:space:]" < "$job_dir/output.limit")
fi
case "$output_limit" in ""|*[!0-9]*) output_limit=65536 ;; esac
STATE_LOCK_STALE_SECONDS=${STATE_LOCK_STALE_SECONDS}
lock_token=""
read_file() {
  if [ -f "$1" ]; then cat -- "$1"; fi
}
write_atomic() {
  target=$1
  value=$2
  tmp="$target.tmp.$$"
  printf '%s\\n' "$value" > "$tmp"
  sync -- "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$target"
}
limit_stream() {
  limit=$1
  path=$2
  total_path=$3
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import sys; limit=int(sys.argv[1]); out=open(sys.argv[2], "wb", buffering=0); total=0
while True:
 chunk=sys.stdin.buffer.read(65536)
 if not chunk: break
 if total < limit: out.write(chunk[:limit-total])
 total += len(chunk)
tmp=open(sys.argv[3] + ".tmp", "w"); tmp.write(str(total) + "\\n"); tmp.close()
import os; os.replace(sys.argv[3] + ".tmp", sys.argv[3])' "$limit" "$path" "$total_path"
  else
    head -c "$limit" > "$path" || return 1
    rest=$(wc -c) || return 1
    written=$(wc -c < "$path") || return 1
    printf '%s\\n' $((written + rest)) > "$total_path.tmp.$$" || return 1
    mv -f -- "$total_path.tmp.$$" "$total_path"
  fi
}
stale_lock_owner_is_confirmed_dead() {
  owner_boot_id=$(cat -- "$lock_dir/lock_owner_boot_id" 2>/dev/null || true)
  owner_pid=$(cat -- "$lock_dir/lock_owner_pid" 2>/dev/null || true)
  owner_starttime=$(cat -- "$lock_dir/lock_owner_starttime" 2>/dev/null || true)
  owner_session_id=$(cat -- "$lock_dir/lock_owner_session_id" 2>/dev/null || true)
  if [ -z "$owner_boot_id" ] || [ -z "$owner_starttime" ] || [ -z "$owner_session_id" ]; then
    return 1
  fi
  case "$owner_boot_id" in ""|*[!A-Fa-f0-9-]*) return 1 ;; esac
  case "$owner_pid" in ""|*[!0-9]*) return 1 ;; esac
  case "$owner_starttime" in ""|*[!0-9]*) return 1 ;; esac
  case "$owner_session_id" in ""|*[!0-9]*) return 1 ;; esac
  if [ "$owner_pid" -le 1 ]; then return 1; fi
  current_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  if [ -z "$current_boot_id" ]; then return 1; fi
  case "$current_boot_id" in ""|*[!A-Fa-f0-9-]*) return 1 ;; esac
  if [ "$owner_boot_id" != "$current_boot_id" ]; then return 0; fi
  if [ ! -r "/proc/$owner_pid/stat" ]; then return 0; fi
  current_pid=$(awk '{print $1}' "/proc/$owner_pid/stat" 2>/dev/null || true)
  current_state=$(awk '{print $3}' "/proc/$owner_pid/stat" 2>/dev/null || true)
  current_starttime=$(awk '{print $22}' "/proc/$owner_pid/stat" 2>/dev/null || true)
  if [ "$current_pid" != "$owner_pid" ] || [ "$current_starttime" != "$owner_starttime" ]; then
    return 0
  fi
  if [ "$current_state" = "Z" ]; then return 0; fi
  current_session_id=$(ps -o sid= -p "$owner_pid" 2>/dev/null | tr -d "[:space:]" || true)
  if [ -z "$current_session_id" ] || [ "$current_session_id" != "$owner_session_id" ]; then
    return 1
  fi
  return 1
}
acquire_state_lock() {
  lock_dir="$job_dir/.state.lock"
  i=0
  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      lock_token="$(date +%s)-$$-$RANDOM"
      lock_owner_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
      lock_owner_pid=$$
      lock_owner_starttime=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null || true)
      lock_owner_session_id=$(ps -o sid= -p "$$" 2>/dev/null | tr -d "[:space:]" || true)
      if [ -z "$lock_token" ] || [ -z "$lock_owner_boot_id" ] || [ -z "$lock_owner_starttime" ] || [ -z "$lock_owner_session_id" ]; then
        rm -rf -- "$lock_dir"
        lock_token=""
        return 1
      fi
      if ! printf '%s\\n' "$(date +%s)" > "$lock_dir/created_at"; then
        rm -rf -- "$lock_dir"
        lock_token=""
        return 1
      fi
      if ! printf '%s\\n' "$lock_token" > "$lock_dir/token"; then
        rm -rf -- "$lock_dir"
        lock_token=""
        return 1
      fi
      printf '%s\\n' "$lock_owner_boot_id" > "$lock_dir/lock_owner_boot_id"
      printf '%s\\n' "$lock_owner_pid" > "$lock_dir/lock_owner_pid"
      printf '%s\\n' "$lock_owner_starttime" > "$lock_dir/lock_owner_starttime"
      printf '%s\\n' "$lock_owner_session_id" > "$lock_dir/lock_owner_session_id"
      sync -- "$lock_dir/created_at" "$lock_dir/token" "$lock_dir/lock_owner_boot_id" "$lock_dir/lock_owner_pid" "$lock_dir/lock_owner_starttime" "$lock_dir/lock_owner_session_id" 2>/dev/null || true
      return 0
    fi
    created_at=$(cat -- "$lock_dir/created_at" 2>/dev/null || true)
    case "$created_at" in ""|*[!0-9]*) created_at=$(date -r "$lock_dir" +%s 2>/dev/null || true) ;; esac
    now=$(date +%s)
    can_reclaim=0
    if [ -n "$created_at" ] && [ "$created_at" -le $((now - STATE_LOCK_STALE_SECONDS)) ]; then
      if stale_lock_owner_is_confirmed_dead; then can_reclaim=1; fi
    fi
    if [ "$can_reclaim" -eq 1 ]; then
      stale_dir="$job_dir/.state.lock.stale.$$.$RANDOM"
      if mv -- "$lock_dir" "$stale_dir" 2>/dev/null; then
        rm -rf -- "$stale_dir"
        continue
      fi
    fi
    i=$((i + 1))
    if [ "$i" -ge 100 ]; then
      printf 'INSTABOX_JOB_LOCK_TIMEOUT\\n' >&2
      return 1
    fi
    sleep 0.05
  done
}
release_state_lock() {
  lock_dir="$job_dir/.state.lock"
  current_token=$(cat -- "$lock_dir/token" 2>/dev/null || true)
  if [ -n "$lock_token" ] && [ "$current_token" = "$lock_token" ]; then
    rm -rf -- "$lock_dir"
  fi
  lock_token=""
}
cleanup() {
  release_state_lock
}
trap cleanup EXIT HUP INT TERM
: > "$job_dir/stdout.part"
: > "$job_dir/stderr.part"
rm -f -- "$job_dir/stdout.pipe" "$job_dir/stderr.pipe"
if ! mkfifo -- "$job_dir/stdout.pipe" "$job_dir/stderr.pipe"; then
  printf 'INSTABOX_JOB_FIFO_FAILED\\n' >&2
  exit 1
fi
acquire_state_lock || exit 1
current_status=$(read_file "$job_dir/status")
if [ "$current_status" = "CANCELLED" ]; then
  release_state_lock
  trap - EXIT HUP INT TERM
  exit 0
fi
write_atomic "$job_dir/pid" "$$"
boot_id=$(cat -- /proc/sys/kernel/random/boot_id)
pid_starttime=$(awk '{print $22}' "/proc/$$/stat")
case "$boot_id" in ""|*[!A-Fa-f0-9-]*) printf 'INSTABOX_JOB_BOOT_ID_INVALID\\n' >&2; exit 1 ;; esac
case "$pid_starttime" in ""|*[!0-9]*) printf 'INSTABOX_JOB_PID_STARTTIME_INVALID\\n' >&2; exit 1 ;; esac
write_atomic "$job_dir/boot_id" "$boot_id"
write_atomic "$job_dir/pid_starttime" "$pid_starttime"
if [ -f "$job_dir/cancel.requested" ]; then
  write_atomic "$job_dir/exit" 130
  write_atomic "$job_dir/finished_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  write_atomic "$job_dir/status" CANCELLED
  release_state_lock
  trap - EXIT HUP INT TERM
  exit 0
fi
write_atomic "$job_dir/status" RUNNING
release_state_lock
trap - EXIT HUP INT TERM
limit_stream "$output_limit" "$job_dir/stdout.part" "$job_dir/stdout.total" < "$job_dir/stdout.pipe" &
stdout_writer=$!
limit_stream "$output_limit" "$job_dir/stderr.part" "$job_dir/stderr.total" < "$job_dir/stderr.pipe" &
stderr_writer=$!
command_digest=$(sha256sum < "$job_dir/command") || command_digest=""
command_digest=\${command_digest%% *}
bash "$job_dir/command" >"$job_dir/stdout.pipe" 2>"$job_dir/stderr.pipe"
exit_code=$?
capture_ok=1
wait "$stdout_writer" || capture_ok=0
wait "$stderr_writer" || capture_ok=0
rm -f -- "$job_dir/stdout.pipe" "$job_dir/stderr.pipe"
cp -p -- "$job_dir/stdout.part" "$job_dir/stdout" 2>/dev/null || capture_ok=0
cp -p -- "$job_dir/stderr.part" "$job_dir/stderr" 2>/dev/null || capture_ok=0
sync -- "$job_dir/stdout" "$job_dir/stderr" 2>/dev/null || capture_ok=0
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
acquire_state_lock || exit 1
current_status=$(read_file "$job_dir/status")
if [ "$current_status" = "CANCELLED" ] || [ -f "$job_dir/cancel.requested" ]; then
  final_status=CANCELLED
  exit_code=130
elif [ "$exit_code" -eq 0 ]; then
  final_status=COMPLETED
else
  final_status=FAILED
fi
# Publish a capture marker only after both streams have been read to EOF and copied.
if [ "$final_status" != "CANCELLED" ] && [ "$capture_ok" = 1 ] && [ -n "$command_digest" ]; then
  write_atomic "$job_dir/output.complete" "$command_digest"
fi
write_atomic "$job_dir/exit" "$exit_code"
write_atomic "$job_dir/finished_at" "$finished_at"
write_atomic "$job_dir/status" "$final_status"
release_state_lock
trap - EXIT HUP INT TERM
exit 0
`.trim();

function startJobCommand(
  jobDirectory: string,
  taskId: string,
  command: string,
  commandHash: string,
  limit: number,
  idempotencyKey?: string,
  requestFingerprint?: string,
): string {
  const encodedCommand = Buffer.from(command, "utf8").toString("base64");
  return `
set -eu
# INSTABOX_JOB_START
job_dir=${shellQuote(jobDirectory)}
task_id=${shellQuote(taskId)}
command_sha256=${shellQuote(commandHash)}
output_limit=${limit}
idempotency_key=${shellQuote(idempotencyKey ?? "")}
request_sha256=${shellQuote(requestFingerprint ?? "")}
command_b64=${shellQuote(encodedCommand)}
for tool in ${INSTABOX_JOB_TOOLS.join(" ")}; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    printf 'INSTABOX_JOB_TOOL_UNAVAILABLE:%s\\n' "$tool" >&2
    exit 127
  fi
done
${JOB_PATH_GUARD_SCRIPT}
umask 077
if [ -L "$job_dir" ]; then
  printf 'INSTABOX_JOB_DIR_SYMLINK\\n' >&2
  exit 2
fi
mkdir -p -- "$job_dir"
assert_no_symlink_components "$job_root" || exit 2
if [ -L "$job_dir" ] || [ ! -d "$job_dir" ]; then
  printf 'INSTABOX_JOB_DIR_INVALID\\n' >&2
  exit 2
fi
chmod 700 -- "$job_dir"
if [ -e "$job_dir/status" ]; then
  printf 'INSTABOX_JOB_ALREADY_EXISTS\\n' >&2
  exit 1
fi
write_atomic() {
  target=$1
  value=$2
  tmp="$target.tmp.$$"
  printf '%s\\n' "$value" > "$tmp"
  sync -- "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$target"
}
write_atomic "$job_dir/task_id" "$task_id"
write_atomic "$job_dir/command.sha256" "$command_sha256"
if [ -n "$idempotency_key" ]; then write_atomic "$job_dir/idempotency.key" "$idempotency_key"; fi
if [ -n "$request_sha256" ]; then write_atomic "$job_dir/request.sha256" "$request_sha256"; fi
write_atomic "$job_dir/output.limit" "$output_limit"
write_atomic "$job_dir/started_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '%s' "$command_b64" | base64 -d > "$job_dir/command.tmp"
chmod 600 -- "$job_dir/command.tmp"
mv -f -- "$job_dir/command.tmp" "$job_dir/command"
# The status file is the start commit point: it is published only after
# the full manifest above. A directory without a status file is an
# uncommitted start whose command never ran, and inspect reports it as
# not found so deterministic recovery can safely dispatch again.
write_atomic "$job_dir/status" STARTING
nohup setsid bash -s -- "$job_dir" "$output_limit" >/dev/null 2>&1 <<'INSTABOX_JOB_WORKER' &
${JOB_WORKER_SCRIPT}
INSTABOX_JOB_WORKER
i=0
while [ "$i" -lt 100 ]; do
  if [ -s "$job_dir/pid" ] && [ -s "$job_dir/boot_id" ] && [ -s "$job_dir/pid_starttime" ]; then break; fi
  current_status=$(cat -- "$job_dir/status" 2>/dev/null || true)
  if [ "$current_status" = "FAILED" ] || [ "$current_status" = "CANCELLED" ]; then break; fi
  sleep 0.05
  i=$((i + 1))
done
if [ ! -s "$job_dir/pid" ] || [ ! -s "$job_dir/boot_id" ] || [ ! -s "$job_dir/pid_starttime" ]; then
  write_atomic "$job_dir/status" FAILED
  printf 'INSTABOX_JOB_START_FAILED\\n' >&2
  exit 1
fi
pid=$(cat -- "$job_dir/pid")
boot_id=$(cat -- "$job_dir/boot_id")
pid_starttime=$(cat -- "$job_dir/pid_starttime")
case "$pid" in ""|*[!0-9]*) printf 'INSTABOX_JOB_PID_INVALID\\n' >&2; exit 1 ;; esac
if [ "$pid" -le 1 ]; then printf 'INSTABOX_JOB_PID_INVALID\\n' >&2; exit 1; fi
case "$pid_starttime" in ""|*[!0-9]*) printf 'INSTABOX_JOB_PID_STARTTIME_INVALID\\n' >&2; exit 1 ;; esac
printf 'TASK_ID=%s\\n' "$task_id"
printf 'STATUS=RUNNING\\n'
printf 'PID=%s\\n' "$pid"
printf 'STARTED_AT=%s\\n' "$(cat -- "$job_dir/started_at")"
printf 'BOOT_ID=%s\\n' "$boot_id"
printf 'PID_STARTTIME=%s\\n' "$pid_starttime"
`.trim();
}

function inspectJobCommand(
  jobDirectory: string,
  taskId: string,
  limit: number,
): string {
  return `
set -eu
# INSTABOX_JOB_INSPECT
job_dir=${shellQuote(jobDirectory)}
task_id=${shellQuote(taskId)}
output_limit=${limit}
${JOB_PATH_GUARD_SCRIPT}
if [ -L "$job_dir" ]; then
  printf 'INSTABOX_JOB_DIR_SYMLINK\\n' >&2
  exit 2
fi
if [ ! -d "$job_dir" ]; then
  printf 'EXISTS=0\\n'
  exit 0
fi
read_file() {
  if [ -f "$1" ]; then cat -- "$1"; fi
}
status=$(read_file "$job_dir/status")
if [ -z "$status" ]; then
  # No committed status: a start that crashed before its commit point.
  # Its command never ran, so report a lookup miss and let recovery
  # dispatch the same deterministic id again.
  printf 'EXISTS=0\\n'
  exit 0
fi
pid=$(read_file "$job_dir/pid")
exit_code=$(read_file "$job_dir/exit")
started_at=$(read_file "$job_dir/started_at")
finished_at=$(read_file "$job_dir/finished_at")
command_sha256=$(read_file "$job_dir/command.sha256")
boot_id=$(read_file "$job_dir/boot_id")
pid_starttime=$(read_file "$job_dir/pid_starttime")
current_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
current_pid=""
current_pid_starttime=""
lost_reason=""
pid_valid=1
case "$pid" in ""|*[!0-9]*) pid_valid=0 ;; esac
if [ "$status" = "RUNNING" ]; then
  if [ -z "$boot_id" ] || [ "$current_boot_id" != "$boot_id" ]; then
    lost_reason=boot_id_mismatch
  elif [ "$pid_valid" -ne 1 ]; then
    lost_reason=pid_mismatch
  elif [ ! -r "/proc/$pid/stat" ]; then
    lost_reason=pid_mismatch
  else
    current_pid=$(awk '{print $1}' "/proc/$pid/stat" 2>/dev/null || true)
    current_pid_starttime=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
    if [ "$current_pid" != "$pid" ]; then
      lost_reason=pid_mismatch
    elif [ -z "$pid_starttime" ] || [ "$current_pid_starttime" != "$pid_starttime" ]; then
      lost_reason=pid_starttime_mismatch
    fi
  fi
  if [ -n "$lost_reason" ]; then
    # The worker may have published its terminal status and exited after
    # our first status read; that is a completed job, not a lost one.
    # Only a job whose status is still non-terminal on re-read is LOST.
    refreshed_status=$(read_file "$job_dir/status")
    case "$refreshed_status" in
      COMPLETED|FAILED|CANCELLED)
        status=$refreshed_status
        lost_reason=""
        exit_code=$(read_file "$job_dir/exit")
        finished_at=$(read_file "$job_dir/finished_at")
        ;;
      *) status=LOST ;;
    esac
  fi
fi
if [ "$status" = "STARTING" ] && [ -z "$pid" ]; then
  # A committed STARTING whose worker never published a pid: while the
  # start that owns it is alive it marks the job FAILED itself within
  # seconds, so a workerless STARTING older than the grace window means
  # that start died after the commit point. Report it lost instead of
  # projecting it as running forever.
  started_epoch=$(date -d "$started_at" +%s 2>/dev/null || true)
  case "$started_epoch" in
    ""|*[!0-9]*) ;;
    *) if [ $(( $(date -u +%s) - started_epoch )) -gt ${STARTING_WITHOUT_WORKER_GRACE_SECONDS} ]; then
         status=LOST
         lost_reason=starting_without_worker
       fi ;;
  esac
fi
stdout_file="$job_dir/stdout"
if [ ! -f "$stdout_file" ]; then stdout_file="$job_dir/stdout.part"; fi
stderr_file="$job_dir/stderr"
if [ ! -f "$stderr_file" ]; then stderr_file="$job_dir/stderr.part"; fi
stdout_saved=0
if [ -f "$stdout_file" ]; then stdout_saved=$(wc -c < "$stdout_file" | tr -d "[:space:]"); fi
stdout_size=$stdout_saved
stdout_total=$(read_file "$job_dir/stdout.total")
stdout_total_legacy=$(printf '%s' "$stdout_total" | tr -d "[:space:]")
case "$stdout_total_legacy" in ""|*[!0-9]*) ;; *) stdout_size=$stdout_total_legacy ;; esac
stderr_saved=0
if [ -f "$stderr_file" ]; then stderr_saved=$(wc -c < "$stderr_file" | tr -d "[:space:]"); fi
stderr_size=$stderr_saved
stderr_total=$(read_file "$job_dir/stderr.total")
stderr_total_legacy=$(printf '%s' "$stderr_total" | tr -d "[:space:]")
case "$stderr_total_legacy" in ""|*[!0-9]*) ;; *) stderr_size=$stderr_total_legacy ;; esac
printf 'EXISTS=1\\n'
printf 'TASK_ID=%s\\n' "$task_id"
printf 'WORKER_TASK_ID=%s\\n' "$(read_file "$job_dir/task_id")"
printf 'STATUS=%s\\n' "$status"
printf 'PID=%s\\n' "$pid"
printf 'EXIT=%s\\n' "$exit_code"
printf 'STARTED_AT=%s\\n' "$started_at"
printf 'FINISHED_AT=%s\\n' "$finished_at"
printf 'COMMAND_SHA256=%s\\n' "$command_sha256"
printf 'IDEMPOTENCY_KEY=%s\\n' "$(read_file "$job_dir/idempotency.key")"
printf 'REQUEST_SHA256=%s\\n' "$(read_file "$job_dir/request.sha256")"
printf 'BOOT_ID=%s\\n' "$boot_id"
printf 'PID_STARTTIME=%s\\n' "$pid_starttime"
printf 'CURRENT_BOOT_ID=%s\\n' "$current_boot_id"
printf 'CURRENT_PID=%s\\n' "$current_pid"
printf 'CURRENT_PID_STARTTIME=%s\\n' "$current_pid_starttime"
printf 'LOST_REASON=%s\\n' "$lost_reason"
printf 'STDOUT_SIZE=%s\\n' "$stdout_size"
printf 'STDOUT_TOTAL=%s\\n' "$stdout_total"
printf 'STDOUT='
stdout_read=0
if [ -f "$stdout_file" ] && (set -o pipefail; head -c "$output_limit" -- "$stdout_file" | base64 | tr -d '\\n'); then stdout_read=1; fi
printf '\\n'
printf 'STDERR_SIZE=%s\\n' "$stderr_size"
printf 'STDERR_TOTAL=%s\\n' "$stderr_total"
printf 'STDERR='
stderr_read=0
if [ -f "$stderr_file" ] && (set -o pipefail; head -c "$output_limit" -- "$stderr_file" | base64 | tr -d '\\n'); then stderr_read=1; fi
printf '\\n'
capture_command_sha256=""
if [ "$stdout_read:$stderr_read" = "1:1" ] \\
  && [ "$stdout_file" = "$job_dir/stdout" ] && [ "$stderr_file" = "$job_dir/stderr" ] \\
  && [ "$stdout_saved:$stderr_saved" = "$stdout_total:$stderr_total" ]; then
  capture_command_sha256=$(read_file "$job_dir/output.complete")
fi
printf 'CAPTURE_COMMAND_SHA256=%s\\n' "$capture_command_sha256"
`.trim();
}

function cancelJobCommand(
  jobDirectory: string,
  taskId: string,
): string {
  return `
set -u
# INSTABOX_JOB_CANCEL
job_dir=${shellQuote(jobDirectory)}
task_id=${shellQuote(taskId)}
STATE_LOCK_STALE_SECONDS=${STATE_LOCK_STALE_SECONDS}
lock_token=""
${JOB_PATH_GUARD_SCRIPT}
if [ -L "$job_dir" ]; then
  printf 'INSTABOX_JOB_DIR_SYMLINK\\n' >&2
  exit 2
fi
if [ ! -d "$job_dir" ]; then
  printf 'EXISTS=0\\n'
  exit 0
fi
read_file() {
  if [ -f "$1" ]; then cat -- "$1"; fi
}
write_atomic() {
  target=$1
  value=$2
  tmp="$target.tmp.$$"
  printf '%s\\n' "$value" > "$tmp"
  sync -- "$tmp" 2>/dev/null || true
  mv -f -- "$tmp" "$target"
}
stale_lock_owner_is_confirmed_dead() {
  owner_boot_id=$(cat -- "$lock_dir/lock_owner_boot_id" 2>/dev/null || true)
  owner_pid=$(cat -- "$lock_dir/lock_owner_pid" 2>/dev/null || true)
  owner_starttime=$(cat -- "$lock_dir/lock_owner_starttime" 2>/dev/null || true)
  owner_session_id=$(cat -- "$lock_dir/lock_owner_session_id" 2>/dev/null || true)
  if [ -z "$owner_boot_id" ] || [ -z "$owner_starttime" ] || [ -z "$owner_session_id" ]; then
    return 1
  fi
  case "$owner_boot_id" in ""|*[!A-Fa-f0-9-]*) return 1 ;; esac
  case "$owner_pid" in ""|*[!0-9]*) return 1 ;; esac
  case "$owner_starttime" in ""|*[!0-9]*) return 1 ;; esac
  case "$owner_session_id" in ""|*[!0-9]*) return 1 ;; esac
  if [ "$owner_pid" -le 1 ]; then return 1; fi
  current_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  if [ -z "$current_boot_id" ]; then return 1; fi
  case "$current_boot_id" in ""|*[!A-Fa-f0-9-]*) return 1 ;; esac
  if [ "$owner_boot_id" != "$current_boot_id" ]; then return 0; fi
  if [ ! -r "/proc/$owner_pid/stat" ]; then return 0; fi
  current_pid=$(awk '{print $1}' "/proc/$owner_pid/stat" 2>/dev/null || true)
  current_state=$(awk '{print $3}' "/proc/$owner_pid/stat" 2>/dev/null || true)
  current_starttime=$(awk '{print $22}' "/proc/$owner_pid/stat" 2>/dev/null || true)
  if [ "$current_pid" != "$owner_pid" ] || [ "$current_starttime" != "$owner_starttime" ]; then
    return 0
  fi
  if [ "$current_state" = "Z" ]; then return 0; fi
  current_session_id=$(ps -o sid= -p "$owner_pid" 2>/dev/null | tr -d "[:space:]" || true)
  if [ -z "$current_session_id" ] || [ "$current_session_id" != "$owner_session_id" ]; then
    return 1
  fi
  return 1
}
acquire_state_lock() {
  lock_dir="$job_dir/.state.lock"
  i=0
  while :; do
    if mkdir "$lock_dir" 2>/dev/null; then
      lock_token="$(date +%s)-$$-$RANDOM"
      lock_owner_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
      lock_owner_pid=$$
      lock_owner_starttime=$(awk '{print $22}' "/proc/$$/stat" 2>/dev/null || true)
      lock_owner_session_id=$(ps -o sid= -p "$$" 2>/dev/null | tr -d "[:space:]" || true)
      if [ -z "$lock_token" ] || [ -z "$lock_owner_boot_id" ] || [ -z "$lock_owner_starttime" ] || [ -z "$lock_owner_session_id" ]; then
        rm -rf -- "$lock_dir"
        lock_token=""
        return 1
      fi
      if ! printf '%s\\n' "$(date +%s)" > "$lock_dir/created_at"; then
        rm -rf -- "$lock_dir"
        lock_token=""
        return 1
      fi
      if ! printf '%s\\n' "$lock_token" > "$lock_dir/token"; then
        rm -rf -- "$lock_dir"
        lock_token=""
        return 1
      fi
      printf '%s\\n' "$lock_owner_boot_id" > "$lock_dir/lock_owner_boot_id"
      printf '%s\\n' "$lock_owner_pid" > "$lock_dir/lock_owner_pid"
      printf '%s\\n' "$lock_owner_starttime" > "$lock_dir/lock_owner_starttime"
      printf '%s\\n' "$lock_owner_session_id" > "$lock_dir/lock_owner_session_id"
      sync -- "$lock_dir/created_at" "$lock_dir/token" "$lock_dir/lock_owner_boot_id" "$lock_dir/lock_owner_pid" "$lock_dir/lock_owner_starttime" "$lock_dir/lock_owner_session_id" 2>/dev/null || true
      return 0
    fi
    created_at=$(cat -- "$lock_dir/created_at" 2>/dev/null || true)
    case "$created_at" in ""|*[!0-9]*) created_at=$(date -r "$lock_dir" +%s 2>/dev/null || true) ;; esac
    now=$(date +%s)
    can_reclaim=0
    if [ -n "$created_at" ] && [ "$created_at" -le $((now - STATE_LOCK_STALE_SECONDS)) ]; then
      if stale_lock_owner_is_confirmed_dead; then can_reclaim=1; fi
    fi
    if [ "$can_reclaim" -eq 1 ]; then
      stale_dir="$job_dir/.state.lock.stale.$$.$RANDOM"
      if mv -- "$lock_dir" "$stale_dir" 2>/dev/null; then
        rm -rf -- "$stale_dir"
        continue
      fi
    fi
    i=$((i + 1))
    if [ "$i" -ge 100 ]; then
      printf 'INSTABOX_JOB_LOCK_TIMEOUT\\n' >&2
      return 1
    fi
    sleep 0.05
  done
}
release_state_lock() {
  lock_dir="$job_dir/.state.lock"
  current_token=$(cat -- "$lock_dir/token" 2>/dev/null || true)
  if [ -n "$lock_token" ] && [ "$current_token" = "$lock_token" ]; then
    rm -rf -- "$lock_dir"
  fi
  lock_token=""
}
acquire_state_lock || exit 1
status=$(read_file "$job_dir/status")
case "$status" in
  CANCELLED)
    release_state_lock
    printf 'EXISTS=1\\nSTATUS=CANCELLED\\nCANCELLED=1\\n'
    exit 0
    ;;
  COMPLETED|FAILED|LOST)
    release_state_lock
    printf 'EXISTS=1\\nSTATUS=%s\\nCANCELLED=0\\n' "$status"
    exit 0
    ;;
esac
pid=$(read_file "$job_dir/pid")
boot_id=$(read_file "$job_dir/boot_id")
pid_starttime=$(read_file "$job_dir/pid_starttime")
verify_identity() {
  current_boot_id=$(cat -- /proc/sys/kernel/random/boot_id 2>/dev/null || true)
  current_pid=""
  current_pid_starttime=""
  lost_reason=""
  pid_valid=1
  case "$pid" in ""|*[!0-9]*) pid_valid=0 ;; esac
  if [ -z "$boot_id" ] || [ "$current_boot_id" != "$boot_id" ]; then
    lost_reason=boot_id_mismatch
  elif [ "$pid_valid" -ne 1 ] || [ "$pid" -le 1 ]; then
    lost_reason=pid_mismatch
  elif [ ! -r "/proc/$pid/stat" ]; then
    lost_reason=pid_mismatch
  else
    current_pid=$(awk '{print $1}' "/proc/$pid/stat" 2>/dev/null || true)
    current_pid_starttime=$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || true)
    if [ "$current_pid" != "$pid" ]; then
      lost_reason=pid_mismatch
    elif [ -z "$pid_starttime" ] || [ "$current_pid_starttime" != "$pid_starttime" ]; then
      lost_reason=pid_starttime_mismatch
    fi
  fi
  if [ -z "$lost_reason" ]; then
    sid=$(ps -o sid= -p "$pid" 2>/dev/null | tr -d "[:space:]" || true)
    if [ "$sid" != "$pid" ]; then lost_reason=process_group_mismatch; fi
  fi
}
group_alive() {
  # Judge by the first character of each member's state field only:
  # zombie (Z) and dead (X) members are not alive, and trailing state
  # modifiers (e.g. the "+" in "Z+" or "S+") must never count as life.
  ps -o stat= -g "$pid" 2>/dev/null | awk '{ s = substr($1, 1, 1); if (s != "" && index("ZzXx", s) == 0) found = 1 } END { exit(found ? 0 : 1) }'
}
cancel_unconfirmed() {
  printf 'EXISTS=1\\nSTATUS=RUNNING\\nCANCELLED=0\\nERROR=CANCELLATION_UNCONFIRMED\\n'
  exit 0
}
verify_identity
if [ -n "$lost_reason" ]; then
  release_state_lock
  printf 'EXISTS=1\\nSTATUS=LOST\\nCANCELLED=0\\nLOST_REASON=%s\\n' "$lost_reason"
  exit 0
fi
write_atomic "$job_dir/cancel.requested" 1
release_state_lock
kill -TERM -- "-$pid" 2>/dev/null || cancel_unconfirmed
i=0
while [ "$i" -lt 20 ]; do
  if ! group_alive; then break; fi
  sleep 0.1
  i=$((i + 1))
done
if group_alive; then
  verify_identity
  if [ -n "$lost_reason" ]; then
    printf 'EXISTS=1\\nSTATUS=LOST\\nCANCELLED=0\\nLOST_REASON=%s\\n' "$lost_reason"
    exit 0
  fi
  kill -KILL -- "-$pid" 2>/dev/null || cancel_unconfirmed
  i=0
  while [ "$i" -lt 20 ]; do
    if ! group_alive; then break; fi
    sleep 0.1
    i=$((i + 1))
  done
fi
if group_alive; then cancel_unconfirmed; fi
if [ ! -f "$job_dir/stdout" ] && [ -f "$job_dir/stdout.part" ]; then cp -p -- "$job_dir/stdout.part" "$job_dir/stdout" 2>/dev/null || true; fi
if [ ! -f "$job_dir/stderr" ] && [ -f "$job_dir/stderr.part" ]; then cp -p -- "$job_dir/stderr.part" "$job_dir/stderr" 2>/dev/null || true; fi
sync -- "$job_dir/stdout" "$job_dir/stderr" 2>/dev/null || true
acquire_state_lock || exit 1
status=$(read_file "$job_dir/status")
case "$status" in
  CANCELLED)
    release_state_lock
    printf 'EXISTS=1\\nSTATUS=CANCELLED\\nCANCELLED=1\\n'
    exit 0
    ;;
  COMPLETED|FAILED|LOST)
    release_state_lock
    printf 'EXISTS=1\\nSTATUS=%s\\nCANCELLED=0\\n' "$status"
    exit 0
    ;;
esac
write_atomic "$job_dir/exit" 130
write_atomic "$job_dir/finished_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
write_atomic "$job_dir/status" CANCELLED
release_state_lock
printf 'EXISTS=1\\nSTATUS=CANCELLED\\nCANCELLED=1\\n'
`.trim();
}

export class InstaboxProvider implements FleetProvider {
  readonly id: string;
  readonly kind = "fleet" as const;
  private readonly apiKey: string;
  private readonly machineName: string;
  private readonly apiBaseUrl: string;
  private readonly nodeId: string;
  private readonly name: string;
  private readonly timeoutMs: number;
  private readonly jobRoot: string;
  private readonly outputLimit: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly tasks = new Map<string, TaskRecord>();

  constructor(options: InstaboxProviderOptions) {
    const apiKey = options.apiKey.trim();
    const machineName = options.machineName.trim();
    if (apiKey === "") throw new Error("INSTABOX_API_KEY_REQUIRED");
    if (machineName === "") throw new Error("INSTABOX_MACHINE_NAME_REQUIRED");
    this.apiKey = apiKey;
    this.id = options.providerId?.trim() || "instabox";
    this.machineName = machineName;
    this.apiBaseUrl = trimTrailingSlash(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
    let apiUrl: URL;
    try {
      apiUrl = new URL(this.apiBaseUrl);
    } catch {
      throw new Error("INSTABOX_API_BASE_URL_INVALID");
    }
    if (apiUrl.protocol !== "https:") {
      throw new Error("INSTABOX_HTTPS_REQUIRED");
    }
    this.nodeId = options.nodeId ?? defaultInstaboxNodeId(machineName);
    this.name = options.name ?? machineName;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs ?? 0) > 0
      ? Math.trunc(options.timeoutMs!)
      : DEFAULT_TIMEOUT_MS;
    this.jobRoot = remoteJobRoot(options.jobRoot ?? DEFAULT_JOB_ROOT);
    this.outputLimit = outputLimit(options.outputLimitBytes);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") throw new Error("INSTABOX_FETCH_UNAVAILABLE");
  }

  async health(): Promise<ProviderStatus> {
    try {
      const machine = await this.getMachine();
      const node = this.toNode(machine);
      return createProviderStatus({
        state: node.status === "online" ? "connected" : node.status === "degraded" ? "degraded" : "offline",
        message: `${node.name}: ${machine.state}`,
      });
    } catch (error) {
      return createProviderStatus({
        state: "offline",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async listNodes(): Promise<NodeRecord[]> {
    return [this.toNode(await this.getMachine())];
  }

  async probeExecCapability(): Promise<ExecCapabilityObservation> {
    const checkedAt = Date.now();
    const parse = (stdout: string) => parseExecCapabilityProbe({
      nodeId: this.nodeId, providerId: this.id, stdout, checkedAt,
      expectedTools: INSTABOX_JOB_TOOLS,
    });
    const unknown = (reason: string): ExecCapabilityObservation => ({
      ...parse(""), reasonCodes: [reason],
    });
    try {
      const machine = await this.getMachine();
      if (machine.id.trim() === "" || machine.name !== this.machineName) {
        return unknown("INSTABOX_MACHINE_IDENTITY_INVALID");
      }
      if (machine.state !== "running" || machine.runtime?.ready !== true) {
        return unknown("INSTABOX_RUNTIME_NOT_READY");
      }
      const result = await this.exec(machine, execCapabilityProbeCommand(this.jobRoot, INSTABOX_JOB_TOOLS));
      if (result.exitCode !== 0) return unknown("EXEC_PROBE_FAILED");
      return parse(result.stdout);
    } catch {
      // API payloads and diagnostic stderr may contain private details; expose stable codes only.
      return unknown("EXEC_PROBE_FAILED");
    }
  }

  async dispatch(input: FleetDispatchInput): Promise<TaskRecord> {
    if (!input.nodeIds.includes(this.nodeId)) {
      throw new Error(`INSTABOX_NODE_NOT_TARGETED:${input.nodeIds.join(",")}`);
    }
    const command = input.command?.trim() ?? "";
    if (command === "") throw new Error("INSTABOX_COMMAND_REQUIRED");
    if (command.includes("\0")) throw new Error("INSTABOX_COMMAND_INVALID");
    let taskId = `INSTABOX-${randomUUID()}`;
    if (input.taskId !== undefined) {
      assertTaskId(input.taskId);
      taskId = input.taskId;
    }
    const idempotencyKey = input.idempotencyKey?.trim();
    const requestFingerprint = input.dispatchFingerprint?.trim();
    if ((idempotencyKey === undefined) !== (requestFingerprint === undefined)) {
      throw new Error("INSTABOX_TASK_IDEMPOTENCY_INVALID");
    }
    const commandHash = createHash("sha256").update(command, "utf8").digest("hex");
    const machine = await this.getMachine();
    let result: InstaboxExecResult;
    try {
      result = await this.exec(machine, startJobCommand(
        this.jobDirectory(taskId),
        taskId,
        command,
        commandHash,
        this.outputLimit,
        idempotencyKey,
        requestFingerprint,
      ));
    } catch (error) {
      return this.recoverIndeterminateStart(machine, input, taskId, error);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `INSTABOX_JOB_START_FAILED:${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    const values = parseKeyValueLines(result.stdout);
    const pid = finiteCount(values.PID);
    const startedAt = values.STARTED_AT;
    const bootId = values.BOOT_ID;
    const pidStarttime = values.PID_STARTTIME;
    if (
      values.TASK_ID !== taskId
      || values.STATUS !== "RUNNING"
      || startedAt === undefined
      || startedAt === ""
      || pid === undefined
      || pid <= 1
      || bootId === undefined
      || bootId === ""
      || pidStarttime === undefined
      || !/^[0-9]+$/u.test(pidStarttime)
    ) {
      throw new Error("INSTABOX_TASK_START_INVALID");
    }
    const now = new Date().toISOString();
    const task: TaskRecord = {
      id: taskId,
      goal: input.goal,
      targetNodeIds: [this.nodeId],
      transport: "dsh-fleet",
      status: "running",
      progress: 20,
      evidence: [{
        kind: "summary",
        label: `${taskId}:summary`,
        value: [
          "status=running",
          `taskId=${taskId}`,
          `pid=${pid}`,
          `bootId=${bootId}`,
          `pidStarttime=${pidStarttime}`,
          `startedAt=${startedAt}`,
          `jobDir=${this.jobDirectory(taskId)}`,
        ].join("\n"),
        sha256: commandHash,
      }],
      expectedEvidence: ["summary", "command", "log"],
      createdAt: startedAt,
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
    const machine = await this.getMachine();
    return this.inspectRemote(machine, taskId);
  }

  private async inspectRemote(
    machine: InstaboxMachine,
    taskId: string,
  ): Promise<TaskRecord> {
    const result = await this.exec(machine, inspectJobCommand(
      this.jobDirectory(taskId),
      taskId,
      this.outputLimit,
    ));
    if (result.exitCode !== 0) {
      throw new Error(
        `INSTABOX_JOB_INSPECT_FAILED:${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    const values = parseKeyValueLines(result.stdout);
    if (values.EXISTS === "0") throw new Error(`INSTABOX_TASK_NOT_FOUND:${taskId}`);
    if (values.EXISTS !== "1") throw new Error("INSTABOX_TASK_INSPECT_INVALID");
    const reportedStatus = remoteTaskStatus(values.STATUS);
    const pid = finiteCount(values.PID);
    const lostReason = lostIdentityReason(values, reportedStatus, pid);
    const status: RemoteTaskStatus = lostReason === undefined ? reportedStatus : "LOST";
    const executionObservation = status === "LOST"
      ? undefined
      : readWorkerExecutionObservation(result.stdout, taskId, this.nodeId, this.outputLimit);
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
    const exitCode = finiteCount(values.EXIT);
    const existing = this.tasks.get(taskId);
    const startedAt = values.STARTED_AT === undefined || values.STARTED_AT === ""
      ? existing?.createdAt ?? new Date().toISOString()
      : values.STARTED_AT;
    const finishedAt = values.FINISHED_AT === undefined || values.FINISHED_AT === ""
      ? undefined
      : values.FINISHED_AT;
    const taskStatus: TaskRecord["status"] = status === "STARTING" || status === "RUNNING"
      ? "running"
      : status === "LOST"
        ? "failed"
      : status === "CANCELLED"
        ? "cancelled"
        : exitCode === 0
          ? "completed"
          : "failed";
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
        `taskId=${taskId}`,
        `pid=${pid === undefined ? "pending" : pid}`,
        `remoteStatus=${status}`,
        `identity=${status === "LOST" ? "lost" : "ok"}`,
        ...(lostReason === undefined ? [] : [`lostReason=${lostReason}`]),
        `exit=${exitCode === undefined ? "pending" : exitCode}`,
        `startedAt=${startedAt}`,
        `stdoutTruncated=${stdout.truncated}`,
        `stderrTruncated=${stderr.truncated}`,
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
      goal: existing?.goal ?? `Instabox task ${taskId}`,
      targetNodeIds: [this.nodeId],
      transport: "dsh-fleet",
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
            error: status === "LOST"
              ? `INSTABOX_TASK_LOST:${lostReason ?? "identity_mismatch"}`
              : `INSTABOX_TASK_FAILED:exit=${exitCode ?? "unknown"}${
                  stderr.value === "" ? "" : `:${stderr.value.slice(0, 1_000)}`
                }`,
          }
        : {}),
    };
    this.tasks.set(taskId, task);
    return task;
  }

  async cancel(taskId: string): Promise<void> {
    assertTaskId(taskId);
    const machine = await this.getMachine();
    const result = await this.exec(machine, cancelJobCommand(
      this.jobDirectory(taskId),
      taskId,
    ));
    if (result.exitCode !== 0) {
      throw new Error(
        `INSTABOX_JOB_CANCEL_FAILED:${result.stderr.trim() || `exit ${result.exitCode}`}`,
      );
    }
    const values = parseKeyValueLines(result.stdout);
    if (values.EXISTS === "0") throw new Error(`INSTABOX_TASK_NOT_FOUND:${taskId}`);
    if (values.EXISTS !== "1" || (values.CANCELLED !== "0" && values.CANCELLED !== "1")) {
      throw new Error("INSTABOX_TASK_CANCEL_INVALID");
    }
    const status = remoteTaskStatus(values.STATUS);
    if (values.CANCELLED === "0") {
      if (values.ERROR !== undefined && values.ERROR !== "") {
        throw new Error(`INSTABOX_TASK_CANCEL_FAILED:${values.ERROR}`);
      }
      throw new Error(`INSTABOX_TASK_ALREADY_TERMINAL:${status}`);
    }
    const existing = this.tasks.get(taskId);
    if (existing === undefined) return;
    this.tasks.set(taskId, {
      ...existing,
      status: "cancelled",
      progress: 100,
      updatedAt: new Date().toISOString(),
    });
  }

  async doctor(): Promise<{ node: NodeRecord; evidence: TaskEvidence[] }> {
    const machine = await this.getMachine();
    const node = this.toNode(machine);
    const result = await this.exec(
      machine,
      "hostname; uname -a; systemctl is-system-running || true; systemctl --failed --no-legend || true",
    );
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `INSTABOX_DOCTOR_EXIT_${result.exitCode}`);
    }
    return {
      node,
      evidence: [{
        kind: "command",
        label: "instabox-doctor",
        value: commandEvidence(result),
      }],
    };
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  private toNode(machine: InstaboxMachine): NodeRecord {
    const running = machine.state === "running";
    const ready = running && machine.runtime?.ready === true;
    return {
      id: this.nodeId,
      externalId: machine.id,
      providerId: this.id,
      name: this.name,
      platform: "linux",
      roles: ["worker"],
      status: ready ? "online" : running ? "degraded" : "offline",
      transports: ["dsh-fleet"],
      capabilities: ["linux", "instabox", "dsh"],
      configState: "unknown",
      ...(ready ? { lastHeartbeat: new Date().toISOString() } : {}),
    };
  }

  /**
   * The node this provider owns, reported without calling the API.
   *
   * The machine name is fixed at construction time, so it stays available
   * when the API cannot be reached. A caller that keeps this node as offline
   * shows "the machine is unreachable" rather than "the machine is gone".
   */
  describeNodes(): NodeRecord[] {
    return [{
      id: this.nodeId,
      externalId: this.machineName,
      providerId: this.id,
      name: this.name,
      platform: "linux",
      roles: ["worker"],
      status: "offline",
      transports: ["dsh-fleet"],
      capabilities: ["linux", "instabox", "dsh"],
      configState: "unknown",
    }];
  }

  private async recoverIndeterminateStart(
    machine: InstaboxMachine,
    input: FleetDispatchInput,
    taskId: string,
    startError: unknown,
  ): Promise<TaskRecord> {
    for (let attempt = 0; attempt < START_RECOVERY_ATTEMPTS; attempt += 1) {
      await wait(START_RECOVERY_DELAY_MS);
      try {
        const inspected = await this.inspectRemote(machine, taskId);
        const task: TaskRecord = {
          ...inspected,
          goal: input.goal,
          ...(input.requestedByBotId === undefined
            ? {}
            : { requestedByBotId: input.requestedByBotId }),
        };
        this.tasks.set(taskId, task);
        return task;
      } catch {
        // The job can appear after the start response is lost; retry briefly.
      }
    }
    throw new Error(
      `INSTABOX_JOB_START_INDETERMINATE:${taskId}:${assertionMessage(startError)}`,
    );
  }

  private jobDirectory(taskId: string): string {
    assertTaskId(taskId);
    return `${this.jobRoot}/${taskId}`;
  }

  private async getMachine(): Promise<InstaboxMachine> {
    const value = await this.request(`/v1/machines/${encodeURIComponent(this.machineName)}`);
    if (
      value === null
      || typeof value !== "object"
      || typeof (value as { id?: unknown }).id !== "string"
      || typeof (value as { name?: unknown }).name !== "string"
      || typeof (value as { state?: unknown }).state !== "string"
    ) {
      throw new Error("INSTABOX_MACHINE_RESPONSE_INVALID");
    }
    return value as InstaboxMachine;
  }

  private async exec(machine: InstaboxMachine, command: string): Promise<InstaboxExecResult> {
    const value = await this.request(`/v1/machines/${encodeURIComponent(machine.id)}/exec`, {
      method: "POST",
      body: JSON.stringify({
        cmd: command,
        timeoutSeconds: Math.max(1, Math.ceil(this.timeoutMs / 1_000)),
      }),
    });
    if (
      value === null
      || typeof value !== "object"
      || typeof (value as { exitCode?: unknown }).exitCode !== "number"
      || typeof (value as { stdout?: unknown }).stdout !== "string"
      || typeof (value as { stderr?: unknown }).stderr !== "string"
    ) {
      throw new Error("INSTABOX_EXEC_RESPONSE_INVALID");
    }
    return value as InstaboxExecResult;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(`${this.apiBaseUrl}${path}`, {
      ...init,
      headers: {
        "x-api-key": this.apiKey,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`INSTABOX_HTTP_${response.status}:${text.slice(0, 512)}`);
    }
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new Error("INSTABOX_RESPONSE_INVALID_JSON");
    }
  }
}
