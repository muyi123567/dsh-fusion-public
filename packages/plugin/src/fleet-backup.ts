import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export interface BackupSource {
  label: string;
  path: string;
}

export interface BackupFile {
  source: string;
  path: string;
  sha256: string;
  bytes: number;
  mode: number;
}

export interface BackupSkipped {
  source: string;
  path: string;
  reason: string;
}

export interface BackupManifest {
  version: 1;
  id: string;
  createdAt: string;
  reason: string;
  files: BackupFile[];
  skipped: BackupSkipped[];
}

export interface BackupSummary {
  id: string;
  createdAt: string;
  reason: string;
  files: number;
  bytes: number;
}

export interface BackupVerifyResult {
  id: string;
  ok: boolean;
  files: Array<{ path: string; status: "ok" | "changed" | "missing" }>;
}

export interface BackupRestorePlan {
  id: string;
  dryRun: boolean;
  approved: boolean;
  files: Array<{ path: string; status: "unchanged" | "changed" | "missing" }>;
  preRestoreId?: string;
}

export class BackupError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "BackupError";
  }
}

export interface FleetBackupServiceOptions {
  directory: string;
  sources: BackupSource[];
  retention?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  denyNames?: string[];
  now?: () => number;
}

export interface WhaleBackupServiceV1 {
  readonly contractVersion: 1;
  snapshot(reason?: string): Promise<BackupManifest>;
  list(): BackupSummary[];
  verify(id: string): BackupVerifyResult;
  restorePlan(id: string): BackupRestorePlan;
  restore(id: string, options?: { dryRun?: boolean; approve?: boolean }): Promise<BackupRestorePlan>;
}

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const RETENTION = 10;
const DENY = ["host-key.pem", ".credentials.yaml", "credentials.json", "id_rsa", "id_ed25519"];
const ID = /^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{8}$/u;

export function createFleetBackupService(options: FleetBackupServiceOptions): WhaleBackupServiceV1 {
  const directory = resolve(options.directory);
  const retention = Math.min(Math.max(options.retention ?? RETENTION, 1), 50);
  const maxFileBytes = Math.min(Math.max(options.maxFileBytes ?? MAX_FILE_BYTES, 1024), 16 * 1024 * 1024);
  const maxTotalBytes = Math.min(Math.max(options.maxTotalBytes ?? MAX_TOTAL_BYTES, 1024), 64 * 1024 * 1024);
  const deny = new Set([...DENY, ...(options.denyNames ?? [])]);
  const now = options.now ?? Date.now;
  const sources = uniqueSources(options.sources);

  const snapshot = async (reason = "manual"): Promise<BackupManifest> => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const createdAt = new Date(now()).toISOString();
    const id = idOf(new Date(now()));
    const target = join(directory, id);
    const temporary = `${target}.tmp-${randomBytes(4).toString("hex")}`;
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const files: BackupFile[] = [];
    const skipped: BackupSkipped[] = [];
    let total = 0;
    try {
      for (const source of sources) {
        if (deny.has(basename(source.path))) {
          skipped.push({ source: source.label, path: source.path, reason: "denied-name" });
          continue;
        }
        let info;
        try {
          info = lstatSync(source.path);
        } catch {
          skipped.push({ source: source.label, path: source.path, reason: "missing" });
          continue;
        }
        if (info.isSymbolicLink()) {
          skipped.push({ source: source.label, path: source.path, reason: "symlink" });
          continue;
        }
        if (!info.isFile()) {
          skipped.push({ source: source.label, path: source.path, reason: "not-file" });
          continue;
        }
        if (info.size > maxFileBytes) {
          skipped.push({ source: source.label, path: source.path, reason: "too-large" });
          continue;
        }
        total += info.size;
        if (total > maxTotalBytes) {
          skipped.push({ source: source.label, path: source.path, reason: "total-too-large" });
          continue;
        }
        const body = readFileSync(source.path);
        const destination = join(temporary, "files", String(files.length));
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        writeFileSync(destination, body, { mode: 0o600 });
        chmodSync(destination, 0o600);
        files.push({
          source: source.label,
          path: source.path,
          sha256: sha256(body),
          bytes: body.byteLength,
          mode: info.mode & 0o777,
        });
      }
      const manifest: BackupManifest = { version: 1, id, createdAt, reason, files, skipped };
      writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      chmodSync(join(temporary, "manifest.json"), 0o600);
      renameSync(temporary, target);
      prune();
      return manifest;
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error instanceof BackupError ? error : new BackupError("backup/snapshot-failed", "快照失败");
    }
  };

  const list = (): BackupSummary[] => {
    let names: string[];
    try {
      names = readdirSync(directory).filter(name => ID.test(name)).sort().reverse();
    } catch {
      return [];
    }
    const summaries: BackupSummary[] = [];
    for (const name of names) {
      try {
        const manifest = readManifest(join(directory, name));
        summaries.push({
          id: manifest.id,
          createdAt: manifest.createdAt,
          reason: manifest.reason,
          files: manifest.files.length,
          bytes: manifest.files.reduce((sum, file) => sum + file.bytes, 0),
        });
      } catch {
        continue;
      }
    }
    return summaries;
  };

  const verify = (id: string): BackupVerifyResult => {
    const manifest = readManifest(join(directory, safeId(id)));
    const results: BackupVerifyResult["files"] = [];
    for (const [index, file] of manifest.files.entries()) {
      try {
        const body = readFileSync(join(directory, manifest.id, "files", String(index)));
        results.push({
          path: file.path,
          status: sha256(body) === file.sha256 ? "ok" : "changed",
        });
      } catch {
        results.push({ path: file.path, status: "missing" });
      }
    }
    return { id: manifest.id, ok: results.every(result => result.status === "ok"), files: results };
  };

  const restorePlan = (id: string): BackupRestorePlan => {
    const manifest = readManifest(join(directory, safeId(id)));
    const files = manifest.files.map(file => {
      if (!existsSync(file.path)) return { path: file.path, status: "missing" as const };
      try {
        const current = readFileSync(file.path);
        return {
          path: file.path,
          status: sha256(current) === file.sha256 ? "unchanged" as const : "changed" as const,
        };
      } catch {
        return { path: file.path, status: "missing" as const };
      }
    });
    return { id: manifest.id, dryRun: true, approved: false, files };
  };

  const restore = async (
    id: string,
    restoreOptions: { dryRun?: boolean; approve?: boolean } = {},
  ): Promise<BackupRestorePlan> => {
    const verification = verify(id);
    if (!verification.ok) throw new BackupError("backup/verify-failed", "快照或当前文件校验失败");
    const plan = restorePlan(id);
    if (restoreOptions.dryRun !== false) return plan;
    if (restoreOptions.approve !== true) throw new BackupError("backup/approval-required", "恢复需要显式批准");

    const manifest = readManifest(join(directory, safeId(id)));
    const preRestore = await snapshot(`pre-restore:${id}`);
    for (const [index, file] of manifest.files.entries()) {
      const body = readFileSync(join(directory, manifest.id, "files", String(index)));
      if (sha256(body) !== file.sha256) throw new BackupError("backup/corrupt", "快照内容校验失败");
      mkdirSync(dirname(file.path), { recursive: true, mode: 0o700 });
      const temporary = `${file.path}.${process.pid}.restore`;
      writeFileSync(temporary, body, { mode: file.mode & 0o777 });
      chmodSync(temporary, file.mode & 0o777);
      renameSync(temporary, file.path);
    }
    return { ...plan, dryRun: false, approved: true, preRestoreId: preRestore.id };
  };

  const prune = (): void => {
    const names = readdirSync(directory).filter(name => ID.test(name)).sort().reverse();
    for (const name of names.slice(retention)) {
      rmSync(join(directory, name), { recursive: true, force: true });
    }
  };

  return { contractVersion: 1, snapshot, list, verify, restorePlan, restore };
}

function uniqueSources(sources: BackupSource[]): BackupSource[] {
  const seen = new Set<string>();
  const result: BackupSource[] = [];
  for (const source of sources) {
    const path = resolve(source.path);
    if (seen.has(path)) continue;
    seen.add(path);
    result.push({ label: source.label, path });
  }
  return result;
}

function readManifest(path: string): BackupManifest {
  try {
    const info = statSync(path);
    if (!info.isDirectory()) throw new Error("not a directory");
    const parsed = JSON.parse(readFileSync(join(path, "manifest.json"), "utf8")) as BackupManifest;
    if (parsed.version !== 1 || typeof parsed.id !== "string" || !Array.isArray(parsed.files)) {
      throw new Error("invalid manifest");
    }
    return parsed;
  } catch {
    throw new BackupError("backup/not-found", "备份不存在或损坏");
  }
}

function safeId(id: string): string {
  if (!ID.test(id)) throw new BackupError("backup/id-invalid", "备份 id 不合法");
  return id;
}

function idOf(date: Date): string {
  const stamp = date.toISOString().replaceAll(/[-:]/gu, "").replace(/\.\d{3}Z$/u, "Z");
  return `${stamp}-${randomBytes(4).toString("hex")}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
