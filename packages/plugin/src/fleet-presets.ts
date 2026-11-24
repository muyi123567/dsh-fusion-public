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
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export type PresetKind = "skill" | "config" | "plugins";

export interface FleetPreset {
  id: string;
  kind: PresetKind;
  title: string;
  description: string;
  tags: string[];
  skill?: { directory: string };
  config?: Record<string, unknown>;
  plugins?: Array<{ name: string; spec: string; why: string }>;
}

export interface PresetSkillStatus {
  state: "installed" | "not-installed" | "modified";
  path?: string;
  installedAt?: string;
}

export interface PresetStatus extends FleetPreset {
  status?: PresetSkillStatus;
}

export interface PresetInstallResult {
  presetId: string;
  path: string;
  files: string[];
  installedAt: string;
  already: boolean;
}

export class PresetError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PresetError";
  }
}

export interface FleetPresetServiceOptions {
  skillsDirectory: string;
  presetRoot?: string;
  now?: () => number;
}

export interface WhalePresetServiceV1 {
  readonly contractVersion: 1;
  list(): PresetStatus[];
  get(id: string): PresetStatus | undefined;
  installSkill(id: string, options?: { overwrite?: boolean }): PresetInstallResult;
  uninstallSkill(id: string, options?: { force?: boolean }): boolean;
}

const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const METADATA = ".dsh-fusion-preset.json";
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const BUILTINS: FleetPreset[] = [
  {
    id: "whale-fleet-ops",
    kind: "skill",
    title: "鲸群多机运维 Skill",
    description: "让 DSH Agent 按安全顺序使用主机、漂移、审批、回执、云盘材料与通知工具。",
    tags: ["skill", "multi-host", "operations"],
    skill: { directory: "skills/whale-fleet-ops" },
  },
  {
    id: "strict-trust",
    kind: "config",
    title: "严格远端信任",
    description: "manual 信任模式 + 独立信任文件；未验签远端一律 unknown。",
    tags: ["config", "security", "multi-host"],
    config: {
      fleetEnvironment: {
        trustMode: "manual",
        trustFile: "/var/lib/dsh-fusion/fleet/trusted-hosts.json",
      },
    },
  },
  {
    id: "chief-approvals",
    kind: "config",
    title: "Chief 审批与通知",
    description: "开启只读 MCP、待审批派发，并把 created/approved/failed 事件送到 IM。",
    tags: ["config", "dsbot", "approval"],
    config: {
      fleetMcp: { enabled: true, port: 8797 },
      fleetNotifications: {
        adapters: [
          { id: "chief-im", kind: "dsh-im", botId: "<bot id>", targetId: "<target id>", format: "markdown" },
        ],
      },
    },
  },
  {
    id: "cloud-materials",
    kind: "config",
    title: "云盘材料源",
    description: "Google Drive / OneDrive / WebDAV 的只读材料拉取模板。",
    tags: ["config", "cloud", "materials"],
    config: {
      fleetConnectors: {
        maxBytes: 67_108_864,
        connectors: [
          {
            id: "team-drive",
            kind: "gdrive",
            refreshTokenEnv: "GOOGLE_DRIVE_REFRESH_TOKEN",
            clientIdEnv: "GOOGLE_DRIVE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_DRIVE_CLIENT_SECRET",
          },
          { id: "one-drive", kind: "onedrive", tokenEnv: "ONEDRIVE_ACCESS_TOKEN" },
          {
            id: "nextcloud",
            kind: "webdav",
            baseUrl: "https://cloud.example.com/remote.php/dav/files/me",
            usernameEnv: "NEXTCLOUD_USER",
            passwordEnv: "NEXTCLOUD_APP_PASSWORD",
          },
        ],
      },
    },
  },
  {
    id: "config-hot-backup",
    kind: "config",
    title: "配置热备",
    description: "在清单摘要变化时自动快照 profile 配置与鲸群状态，保留最近 10 份。",
    tags: ["config", "backup", "recovery"],
    config: {
      fleetBackup: {
        directory: "/var/lib/dsh-fusion/fleet/backups",
        retention: 10,
        auto: true,
      },
    },
  },
  {
    id: "popular-companions",
    kind: "plugins",
    title: "热门 DSH 插件",
    description: "已验证兼容的 IM、QQ、模型观察与多 Agent 插件清单；复制命令后由宿主安装。",
    tags: ["plugins", "ecosystem"],
    plugins: [
      { name: "@xmanrui/dsh-im", spec: "@xmanrui/dsh-im@5.10.0", why: "IM 渠道与 sendChecked 回执" },
      { name: "@tencent-connect/dsh-qqbot", spec: "@tencent-connect/dsh-qqbot@0.5.5", why: "QQ 机器人接入" },
      { name: "@liustack/modlens", spec: "@liustack/modlens@3.27.5", why: "模型与上下文观测" },
      { name: "@nanmicoder/dsh-agent-teams", spec: "@nanmicoder/dsh-agent-teams@0.1.30", why: "多 Agent 团队协作" },
    ],
  },
];

export function createFleetPresetService(options: FleetPresetServiceOptions): WhalePresetServiceV1 {
  const presetRoot = options.presetRoot ?? fileURLToPath(new URL("../presets", import.meta.url));
  const now = options.now ?? Date.now;
  const skillsDirectory = resolve(options.skillsDirectory);

  const statusOf = (preset: FleetPreset): PresetSkillStatus | undefined => {
    if (preset.kind !== "skill") return undefined;
    const target = join(skillsDirectory, preset.id);
    let metadata: PresetMetadata;
    try {
      metadata = JSON.parse(readFileSync(join(target, METADATA), "utf8")) as PresetMetadata;
    } catch {
      return { state: "not-installed", path: target };
    }
    if (metadata.version !== 1 || metadata.preset !== preset.id || typeof metadata.files !== "object") {
      return { state: "modified", path: target };
    }
    for (const [relativePath, digest] of Object.entries(metadata.files)) {
      try {
        const actual = sha256(readFileSync(join(target, relativePath)));
        if (actual !== digest) return { state: "modified", path: target, installedAt: metadata.installedAt };
      } catch {
        return { state: "modified", path: target, installedAt: metadata.installedAt };
      }
    }
    return { state: "installed", path: target, installedAt: metadata.installedAt };
  };

  const list = (): PresetStatus[] => BUILTINS.map(preset => {
    const status = preset.kind === "skill" ? statusOf(preset) : undefined;
    return {
      ...structuredClone(preset),
      ...(status === undefined ? {} : { status }),
    };
  });

  const get = (id: string): PresetStatus | undefined => list().find(preset => preset.id === id);

  const installSkill = (id: string, installOptions: { overwrite?: boolean } = {}): PresetInstallResult => {
    if (!SKILL_ID.test(id)) throw new PresetError("preset/id-invalid", "预设 id 不合法");
    const preset = BUILTINS.find(candidate => candidate.id === id && candidate.kind === "skill");
    if (preset?.skill === undefined) throw new PresetError("preset/not-skill", "不是 Skill 预设");
    const source = resolve(presetRoot, preset.skill.directory);
    if (!source.startsWith(`${resolve(presetRoot)}${sep}`)) throw new PresetError("preset/path-invalid", "Skill 源路径不合法");
    const files = collectFiles(source);
    if (files.length === 0) throw new PresetError("preset/empty", "Skill 预设没有文件");
    const target = join(skillsDirectory, id);
    const current = statusOf(preset);
    if (current?.state === "installed" && installOptions.overwrite !== true) {
      return {
        presetId: id, path: target, files: Object.keys(readMetadata(target).files),
        installedAt: current.installedAt ?? new Date(now()).toISOString(), already: true,
      };
    }
    if (current?.state === "modified" && installOptions.overwrite !== true) {
      throw new PresetError("preset/modified", "已安装的 Skill 被修改；需要 overwrite");
    }
    if (existsSync(target) && current?.state === "not-installed" && installOptions.overwrite !== true) {
      throw new PresetError("preset/exists", "目标 Skill 目录已存在；需要 overwrite");
    }

    mkdirSync(skillsDirectory, { recursive: true, mode: 0o700 });
    const temporary = join(skillsDirectory, `.tmp-${id}-${randomBytes(6).toString("hex")}`);
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    const hashes: Record<string, string> = {};
    let total = 0;
    for (const file of files) {
      const body = readFileSync(join(source, file));
      total += body.byteLength;
      if (body.byteLength > MAX_FILE_BYTES || total > MAX_TOTAL_BYTES) {
        rmSync(temporary, { recursive: true, force: true });
        throw new PresetError("preset/too-large", "Skill 预设超过大小限制");
      }
      const destination = join(temporary, file);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, body, { mode: 0o644 });
      chmodSync(destination, 0o644);
      hashes[file] = sha256(body);
    }
    const installedAt = new Date(now()).toISOString();
    writeFileSync(join(temporary, METADATA), `${JSON.stringify({
      version: 1, preset: id, installedAt, files: hashes, source: "dsh-fusion-preset",
    }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(join(temporary, METADATA), 0o600);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    renameDirectory(temporary, target);
    return { presetId: id, path: target, files: Object.keys(hashes), installedAt, already: false };
  };

  const uninstallSkill = (id: string, uninstallOptions: { force?: boolean } = {}): boolean => {
    if (!SKILL_ID.test(id)) throw new PresetError("preset/id-invalid", "预设 id 不合法");
    const preset = BUILTINS.find(candidate => candidate.id === id && candidate.kind === "skill");
    if (preset === undefined) throw new PresetError("preset/not-skill", "不是 Skill 预设");
    const target = join(skillsDirectory, id);
    if (!existsSync(target)) return false;
    const metadata = readMetadata(target);
    if (metadata.preset !== id) throw new PresetError("preset/foreign", "目标目录不是该预设安装的");
    if (uninstallOptions.force !== true) {
      for (const [relativePath, digest] of Object.entries(metadata.files)) {
        try {
          if (sha256(readFileSync(join(target, relativePath))) !== digest) {
            throw new PresetError("preset/modified", "Skill 文件已被修改；需要 force");
          }
        } catch (error) {
          if (error instanceof PresetError) throw error;
          throw new PresetError("preset/modified", "Skill 文件缺失；需要 force");
        }
      }
    }
    rmSync(target, { recursive: true, force: true });
    return true;
  };

  return { contractVersion: 1, list, get, installSkill, uninstallSkill };
}

interface PresetMetadata {
  version: 1;
  preset: string;
  installedAt: string;
  files: Record<string, string>;
  source: string;
}

function readMetadata(target: string): PresetMetadata {
  try {
    const parsed = JSON.parse(readFileSync(join(target, METADATA), "utf8")) as PresetMetadata;
    if (parsed.version === 1 && typeof parsed.preset === "string" && typeof parsed.files === "object") return parsed;
  } catch {
    // fall through
  }
  throw new PresetError("preset/foreign", "目标目录缺少有效的预设元数据");
}

function collectFiles(root: string, base = root): string[] {
  const result: string[] = [];
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) result.push(...collectFiles(path, base));
    else if (info.isFile()) result.push(relative(base, path).split(sep).join("/"));
  }
  return result;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function renameDirectory(source: string, target: string): void {
  // rename(2) is atomic on the same filesystem; fall back to a copy when it is not.
  try {
    renameSync(source, target);
  } catch {
    mkdirSync(target, { recursive: true, mode: 0o700 });
    for (const file of collectFiles(source)) {
      const destination = join(target, file);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, readFileSync(join(source, file)), { mode: 0o644 });
    }
    rmSync(source, { recursive: true, force: true });
  }
}
