import { createHash } from "node:crypto";
import { z } from "zod";

const SECRET_LIKE_VALUE = /\b(?:api[-_]?key|authorization|bearer|password|passwd|private[-_]?key|secret|token)\b/i;
const SSH_TRANSPORT_ERROR = /\b(?:connection (?:closed|refused|reset|timed out)|host key verification failed|remote host identification has changed|ssh: not found|spawn .*enoent|timed out)\b/i;
const INPUT_FIELDS = new Set([
  "nodeId",
  "displayName",
  "dshVersion",
  "workspaceRoot",
  "capabilities",
]);

function secretFreeText(maxLength: number): z.ZodType<string> {
  return z.string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine((value) => !SECRET_LIKE_VALUE.test(value), {
      message: "REMOTE_CONFIG_SECRET_VALUE",
    });
}

const capabilitySchema = z.string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "REMOTE_CONFIG_INVALID_CAPABILITY")
  .refine((value) => !SECRET_LIKE_VALUE.test(value), {
    message: "REMOTE_CONFIG_SECRET_VALUE",
  });

export const remoteNodeConfigSchema = z.object({
  version: z.literal(1),
  nodeId: z.string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, "REMOTE_CONFIG_INVALID_NODE_ID"),
  displayName: secretFreeText(80),
  dshVersion: z.string()
    .trim()
    .max(64)
    .regex(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      "REMOTE_CONFIG_INVALID_DSH_VERSION",
    ),
  workspaceRoot: z.string()
    .trim()
    .min(1)
    .max(240)
    .refine(
      (value) => value.startsWith("/")
        && !value.includes("//")
        && !value.split("/").includes("..")
        && /^[\x20-\x7e]+$/.test(value),
      "REMOTE_CONFIG_INVALID_WORKSPACE",
    )
    .refine((value) => !SECRET_LIKE_VALUE.test(value), {
      message: "REMOTE_CONFIG_SECRET_VALUE",
    }),
  transport: z.literal("ssh"),
  capabilities: z.array(capabilitySchema).max(32).default([]),
}).strict();

export type RemoteNodeConfig = z.infer<typeof remoteNodeConfigSchema>;

export interface RemoteNodeConfigInput {
  nodeId: string;
  displayName: string;
  dshVersion: string;
  workspaceRoot: string;
  capabilities?: string[];
}

export interface RenderedRemoteNodeConfig {
  config: RemoteNodeConfig;
  json: string;
  hash: string;
}

export interface RemoteCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
}

export type RemoteCommandRunner = (command: string) => Promise<RemoteCommandResult>;

export interface RemoteNodeConfigServiceOptions {
  run: RemoteCommandRunner;
  configPath: string;
  backupPath?: string;
}

export type RemoteNodeConfigState =
  | "current"
  | "drift"
  | "missing"
  | "invalid"
  | "unreachable"
  | "doctor-failed"
  | "apply-failed";

export interface RemoteNodeConfigCheck {
  id: string;
  ok: boolean;
  message?: string;
}

export interface RemoteNodeConfigDoctorReport {
  ok: boolean;
  state: RemoteNodeConfigState;
  activeHash?: string;
  message?: string;
  checks: RemoteNodeConfigCheck[];
}

export interface RemoteNodeConfigApplyResult {
  nodeId: string;
  previousHash?: string;
  desiredHash: string;
  activeHash?: string;
  applied: boolean;
  rolledBack: boolean;
  rollbackAttempted: boolean;
  rollbackError?: string;
  doctor: RemoteNodeConfigDoctorReport;
}

interface RemoteNodeConfigRollbackResult {
  rolledBack: boolean;
  error?: string;
}

const ROLLBACK_DIAGNOSTIC_MAX_LENGTH = 240;
const SENSITIVE_ROLLBACK_TERM = [
  "pass(?:word|wd)?",
  "pwd",
  "token",
  "secret",
  "api[-_]?key",
  "private[-_ ]?key",
  "authorization",
  "credential",
].join("|");
const SENSITIVE_ROLLBACK_KEY = [
  String.raw`(?:[A-Za-z0-9]+[-_])*`,
  `(?:${SENSITIVE_ROLLBACK_TERM})`,
  String.raw`(?:[-_][A-Za-z0-9]+)*`,
].join("");
const SENSITIVE_ROLLBACK_KEY_VALUE = new RegExp(
  String.raw`(?<![\w-])(["']?(?:${SENSITIVE_ROLLBACK_KEY})["']?\s*(?:=|:)\s*|\b(?:${SENSITIVE_ROLLBACK_KEY})\b\s+)("[^"]*"|'[^']*'|Bearer\s+[^\s,;]+|[^\s,;]+)`,
  "gi",
);

function truncate(value: string, maxLength: number): string {
  const characters = Array.from(value);
  return characters.length <= maxLength
    ? value
    : `${characters.slice(0, maxLength - 3).join("")}...`;
}

function sanitizeRollbackDetail(value: string): string {
  let detail = value.split(/\r\n|\r|\n/, 1)[0] ?? "";
  detail = detail.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
  detail = detail.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/gi,
    "[REDACTED_PRIVATE_KEY]",
  );
  detail = detail.replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
  detail = detail.replace(SENSITIVE_ROLLBACK_KEY_VALUE, "$1[REDACTED]");
  detail = detail.replace(
    /(\/\/[^/\s:@]+:)[^@\s/]+@/g,
    "$1[REDACTED]@",
  );
  detail = detail.replace(/\s+/g, " ").trim();
  return detail || "unknown error";
}

function rollbackFailureError(detail: string): string {
  return truncate(
    `REMOTE_CONFIG_ROLLBACK_FAILED:${sanitizeRollbackDetail(detail)}`,
    ROLLBACK_DIAGNOSTIC_MAX_LENGTH,
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function remotePath(value: string, label: string): string {
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
    throw new Error(`REMOTE_CONFIG_INVALID_${label}`);
  }
  return value;
}

function assertOnlyInputFields(input: RemoteNodeConfigInput): void {
  const unknown = Object.keys(input).filter((key) => !INPUT_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new Error(`REMOTE_CONFIG_UNKNOWN_FIELDS:${unknown.sort().join(",")}`);
  }
}

export function validateRemoteNodeConfig(value: unknown): RemoteNodeConfig {
  return remoteNodeConfigSchema.parse(value);
}

export function renderRemoteNodeConfig(
  input: RemoteNodeConfigInput,
): RenderedRemoteNodeConfig {
  assertOnlyInputFields(input);
  const config = validateRemoteNodeConfig({
    version: 1,
    nodeId: input.nodeId,
    displayName: input.displayName,
    dshVersion: input.dshVersion,
    workspaceRoot: input.workspaceRoot,
    transport: "ssh",
    capabilities: input.capabilities ?? [],
  });
  const json = `${JSON.stringify(config, null, 2)}\n`;
  return { config, json, hash: sha256(json) };
}

interface RemoteFileState {
  exists: boolean;
  json?: string;
  hash?: string;
}

function parseKeyValueLines(stdout: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    values[key] = line.slice(separator + 1).trim();
  }
  return values;
}

function doctorCommand(configPath: string): string {
  return [
    "set -eu",
    "# REMOTE_NODE_CONFIG_DOCTOR",
    'for tool in base64 tr; do',
    '  if ! command -v "$tool" >/dev/null 2>&1; then',
    "    printf 'REMOTE_CONFIG_TOOL_UNAVAILABLE:%s\\n' \"$tool\" >&2",
    "    exit 127",
    "  fi",
    "done",
    `target=${shellQuote(configPath)}`,
    'if [ -f "$target" ]; then',
    "  printf 'EXISTS=1\\nDATA='",
    "  base64 < \"$target\" | tr -d '\\n'",
    "  printf '\\n'",
    "else",
    "  printf 'EXISTS=0\\n'",
    "fi",
  ].join("\n");
}

function jsonValidationLines(): string[] {
  return [
    "if command -v python3 >/dev/null 2>&1; then",
    '  if ! python3 -c \'import json,sys; json.load(open(sys.argv[1], encoding="utf-8"))\' "$tmp" >/dev/null 2>&1; then',
    "    printf 'REMOTE_CONFIG_JSON_INVALID\\n' >&2",
    "    exit 1",
    "  fi",
    "elif command -v jq >/dev/null 2>&1; then",
    '  if ! jq -e . "$tmp" >/dev/null 2>&1; then',
    "    printf 'REMOTE_CONFIG_JSON_INVALID\\n' >&2",
    "    exit 1",
    "  fi",
    "elif command -v node >/dev/null 2>&1; then",
    "  if ! node -e 'const fs=require(\"node:fs\"); JSON.parse(fs.readFileSync(process.argv[1], \"utf8\"));' \"$tmp\" >/dev/null 2>&1; then",
    "    printf 'REMOTE_CONFIG_JSON_INVALID\\n' >&2",
    "    exit 1",
    "  fi",
    "else",
    "  printf 'REMOTE_CONFIG_VALIDATOR_UNAVAILABLE\\n' >&2",
    "  exit 127",
    "fi",
  ];
}

function applyCommand(
  configPath: string,
  backupPath: string,
  rendered: RenderedRemoteNodeConfig,
): string {
  const payload = Buffer.from(rendered.json, "utf8").toString("base64");
  return [
    "set -eu",
    "# REMOTE_NODE_CONFIG_APPLY",
    `target=${shellQuote(configPath)}`,
    `backup=${shellQuote(backupPath)}`,
    'tmp="${target}.tmp.$$"',
    'backup_tmp="${backup}.tmp.$$"',
    'cleanup() { rm -f -- "$tmp" "$backup_tmp"; }',
    "trap cleanup EXIT HUP INT TERM",
    'for tool in base64 sha256sum sync dirname cp mv chmod rm; do',
    '  if ! command -v "$tool" >/dev/null 2>&1; then',
    "    printf 'REMOTE_CONFIG_TOOL_UNAVAILABLE:%s\\n' \"$tool\" >&2",
    "    exit 127",
    "  fi",
    "done",
    'mkdir -p -- "$(dirname -- "$target")" "$(dirname -- "$backup")"',
    'rm -f -- "$backup" "$backup_tmp"',
    'if [ -e "$target" ]; then',
    '  cp -p -- "$target" "$backup_tmp"',
    '  chmod go-rwx -- "$backup_tmp"',
    '  sync -- "$backup_tmp"',
    '  mv -f -- "$backup_tmp" "$backup"',
    "fi",
    "umask 077",
    `printf '%s' ${shellQuote(payload)} | base64 -d > "$tmp"`,
    ...jsonValidationLines(),
    'chmod 600 -- "$tmp"',
    'sync -- "$tmp"',
    'mv -f -- "$tmp" "$target"',
    "trap - EXIT HUP INT TERM",
    'actual="$(sha256sum -- "$target")"',
    'actual="${actual%% *}"',
    `if [ "$actual" != ${shellQuote(rendered.hash)} ]; then exit 1; fi`,
    "printf 'APPLIED=1\\nSHA256=%s\\nATOMIC=1\\n' \"$actual\"",
  ].join("\n");
}

function rollbackCommand(
  configPath: string,
  backupPath: string,
  hadFile: boolean,
  expectedHash: string | undefined,
): string {
  return [
    "set -eu",
    "# REMOTE_NODE_CONFIG_ROLLBACK",
    `target=${shellQuote(configPath)}`,
    `backup=${shellQuote(backupPath)}`,
    'rollback_tmp="${target}.rollback.$$"',
    'cleanup() { rm -f -- "$rollback_tmp"; }',
    "trap cleanup EXIT HUP INT TERM",
    ...(hadFile
      ? [
          'if [ -f "$backup" ]; then',
          '  cp -p -- "$backup" "$rollback_tmp"',
          '  sync -- "$rollback_tmp"',
          '  mv -f -- "$rollback_tmp" "$target"',
          'elif [ ! -f "$target" ]; then',
          "  exit 1",
          "fi",
        ]
      : ['rm -f -- "$target"']),
    ...(expectedHash === undefined
      ? []
      : [
          'actual="$(sha256sum -- "$target")"',
          'actual="${actual%% *}"',
          `if [ "$actual" != ${shellQuote(expectedHash)} ]; then exit 1; fi`,
        ]),
    'rm -f -- "$backup"',
    "trap - EXIT HUP INT TERM",
    "printf 'ROLLED_BACK=1\\n'",
  ].join("\n");
}

function unreachableReport(error: unknown): RemoteNodeConfigDoctorReport {
  return {
    ok: false,
    state: "unreachable",
    message: error instanceof Error ? error.message : String(error),
    checks: [{ id: "ssh", ok: false }],
  };
}

function doctorFailureReport(result: RemoteCommandResult): RemoteNodeConfigDoctorReport {
  const errorCode = result.errorCode?.toUpperCase();
  const message = result.stderr.trim()
    || `Huawei doctor exited ${result.exitCode}${errorCode === undefined ? "" : ` (${errorCode})`}`;
  const localSshFailure = errorCode === "ENOENT"
    || errorCode === "EACCES"
    || errorCode === "EPERM"
    || errorCode === "ETIMEDOUT";
  const transportFailure = result.exitCode === 124
    || result.exitCode === 255
    || localSshFailure
    || SSH_TRANSPORT_ERROR.test(message);
  if (transportFailure) return unreachableReport(message);
  return {
    ok: false,
    state: "doctor-failed",
    message,
    checks: [
      { id: "ssh", ok: true },
      { id: "config-output", ok: false },
    ],
  };
}

function failureReport(message: string): RemoteNodeConfigDoctorReport {
  return {
    ok: false,
    state: "apply-failed",
    message,
    checks: [{ id: "apply", ok: false, message }],
  };
}

export class RemoteNodeConfigService {
  private readonly run: RemoteCommandRunner;
  private readonly configPath: string;
  private readonly backupPath: string;
  private applyQueue: Promise<void> = Promise.resolve();

  constructor(options: RemoteNodeConfigServiceOptions) {
    this.run = options.run;
    this.configPath = remotePath(options.configPath, "CONFIG_PATH");
    this.backupPath = remotePath(
      options.backupPath ?? `${this.configPath}.bak`,
      "BACKUP_PATH",
    );
    if (this.configPath === this.backupPath) {
      throw new Error("REMOTE_CONFIG_PATH_COLLISION");
    }
  }

  async doctor(input: RemoteNodeConfigInput): Promise<RemoteNodeConfigDoctorReport> {
    return await this.doctorRendered(renderRemoteNodeConfig(input));
  }

  async apply(input: RemoteNodeConfigInput): Promise<RemoteNodeConfigApplyResult> {
    const previous = this.applyQueue;
    let release: () => void = () => {};
    this.applyQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.applyExclusive(input);
    } finally {
      release();
    }
  }

  private async applyExclusive(input: RemoteNodeConfigInput): Promise<RemoteNodeConfigApplyResult> {
    const rendered = renderRemoteNodeConfig(input);
    const initial = await this.doctorRendered(rendered);
    if (initial.state === "current") {
      return {
        nodeId: rendered.config.nodeId,
        desiredHash: rendered.hash,
        activeHash: rendered.hash,
        applied: false,
        rolledBack: false,
        rollbackAttempted: false,
        doctor: initial,
      };
    }
    if (initial.state === "unreachable" || initial.state === "doctor-failed") {
      return {
        nodeId: rendered.config.nodeId,
        desiredHash: rendered.hash,
        applied: false,
        rolledBack: false,
        rollbackAttempted: false,
        doctor: initial,
      };
    }

    const hadFile = initial.state !== "missing";
    const previousHash = initial.activeHash;
    let applyFailure: string | undefined;
    try {
      const result = await this.run(
        applyCommand(this.configPath, this.backupPath, rendered),
      );
      if (result.exitCode !== 0) {
        applyFailure = result.stderr.trim() || `Huawei apply exited ${result.exitCode}`;
      } else {
        const values = parseKeyValueLines(result.stdout);
        if (
          values.APPLIED !== "1"
          || values.SHA256 !== rendered.hash
          || values.ATOMIC !== "1"
        ) {
          applyFailure = "REMOTE_CONFIG_APPLY_NOT_CONFIRMED";
        }
      }
    } catch (error) {
      applyFailure = error instanceof Error ? error.message : String(error);
    }

    if (applyFailure !== undefined) {
      const rollback = await this.rollback(hadFile, previousHash);
      return {
        nodeId: rendered.config.nodeId,
        desiredHash: rendered.hash,
        applied: false,
        rolledBack: rollback.rolledBack,
        rollbackAttempted: true,
        ...(rollback.error === undefined ? {} : { rollbackError: rollback.error }),
        ...(previousHash === undefined ? {} : { previousHash }),
        ...(rollback.rolledBack && previousHash !== undefined
          ? { activeHash: previousHash }
          : {}),
        doctor: failureReport(applyFailure),
      };
    }

    const doctor = await this.doctorRendered(rendered);
    if (doctor.state === "current") {
      return {
        nodeId: rendered.config.nodeId,
        desiredHash: rendered.hash,
        activeHash: rendered.hash,
        applied: true,
        rolledBack: false,
        rollbackAttempted: false,
        ...(previousHash === undefined ? {} : { previousHash }),
        doctor,
      };
    }

    const rollback = await this.rollback(hadFile, previousHash);
    return {
      nodeId: rendered.config.nodeId,
      desiredHash: rendered.hash,
      applied: false,
      rolledBack: rollback.rolledBack,
      rollbackAttempted: true,
      ...(rollback.error === undefined ? {} : { rollbackError: rollback.error }),
      ...(previousHash === undefined ? {} : { previousHash }),
      ...(rollback.rolledBack && previousHash !== undefined
        ? { activeHash: previousHash }
        : doctor.activeHash === undefined
          ? {}
          : { activeHash: doctor.activeHash }),
      doctor,
    };
  }

  private async doctorRendered(
    rendered: RenderedRemoteNodeConfig,
  ): Promise<RemoteNodeConfigDoctorReport> {
    let state: RemoteFileState;
    try {
      const result = await this.run(doctorCommand(this.configPath));
      if (result.exitCode !== 0) {
        return doctorFailureReport(result);
      }
      const values = parseKeyValueLines(result.stdout);
      if (values.EXISTS === "0") {
        state = { exists: false };
      } else if (values.EXISTS === "1" && values.DATA !== undefined) {
        const json = Buffer.from(values.DATA, "base64").toString("utf8");
        state = { exists: true, json, hash: sha256(json) };
      } else {
        return {
          ok: false,
          state: "doctor-failed",
          message: "REMOTE_CONFIG_DOCTOR_OUTPUT_INVALID",
          checks: [{ id: "ssh", ok: true }, { id: "config-output", ok: false }],
        };
      }
    } catch (error) {
      return unreachableReport(error);
    }

    if (!state.exists) {
      return {
        ok: false,
        state: "missing",
        checks: [
          { id: "ssh", ok: true },
          { id: "config-present", ok: false },
        ],
      };
    }

    let config: RemoteNodeConfig;
    try {
      config = validateRemoteNodeConfig(JSON.parse(state.json ?? ""));
    } catch (error) {
      return {
        ok: false,
        state: "invalid",
        ...(state.hash === undefined ? {} : { activeHash: state.hash }),
        message: error instanceof Error ? error.message : String(error),
        checks: [
          { id: "ssh", ok: true },
          { id: "config-present", ok: true },
          { id: "config-schema", ok: false },
        ],
      };
    }

    const activeHash = state.hash;
    const current = activeHash === rendered.hash && config.nodeId === rendered.config.nodeId;
    return {
      ok: current,
      state: current ? "current" : "drift",
      ...(activeHash === undefined ? {} : { activeHash }),
      checks: [
        { id: "ssh", ok: true },
        { id: "config-present", ok: true },
        { id: "config-schema", ok: true },
        { id: "config-hash", ok: current },
      ],
    };
  }

  private async rollback(
    hadFile: boolean,
    expectedHash: string | undefined,
  ): Promise<RemoteNodeConfigRollbackResult> {
    try {
      const result = await this.run(
        rollbackCommand(this.configPath, this.backupPath, hadFile, expectedHash),
      );
      if (result.exitCode !== 0) {
        const errorCode = result.errorCode === undefined ? "" : ` (${result.errorCode})`;
        const detail = result.stderr.trim() || `exit ${result.exitCode}${errorCode}`;
        return {
          rolledBack: false,
          error: rollbackFailureError(detail),
        };
      }
      if (parseKeyValueLines(result.stdout).ROLLED_BACK !== "1") {
        return {
          rolledBack: false,
          error: "REMOTE_CONFIG_ROLLBACK_NOT_CONFIRMED:ROLLED_BACK",
        };
      }
      return { rolledBack: true };
    } catch (error) {
      const detail = error instanceof Error ? error.message.trim() : String(error).trim();
      return {
        rolledBack: false,
        error: rollbackFailureError(detail || "unknown error"),
      };
    }
  }
}
