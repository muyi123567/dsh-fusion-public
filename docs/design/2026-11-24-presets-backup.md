# 预设中心与配置热备

日期：2026-11-24。代码：`packages/plugin/src/fleet-presets.ts`、`fleet-backup.ts`，
面板 `packages/client/src/features/native-panel/NativePresetsBackup.tsx`。

## 目标

让新用户不用读完整文档就能把鲸群用起来，并让老用户在改坏配置后能快速回到上一个
可用状态：

1. 可安装的 DSH Skill；
2. 热门插件与配置模板；
3. 配置热备：摘要变化自动快照、校验、恢复演练与显式恢复。

## Skill 预设

内置 `whale-fleet-ops`，内容是鲸群工具的安全使用顺序：
`whale_list_hosts → diff → plan → request → human approve → receipt`，
并说明云盘、通知、信任表与“不得泄露令牌”的边界。

安装位置：

- 默认 `~/.dsh/skills/<preset-id>`；
- 可用 `fleetPresets.skillsDirectory` 覆盖；
- DSH 的 filesystem skill provider 会自动发现该目录下的 `SKILL.md`。

安装使用目录级原子替换，写入 `.dsh-fusion-preset.json`（0600）记录每个文件的
sha256。重复安装幂等；目标已存在但不是该预设安装的目录时拒绝覆盖；文件被修改后
卸载需要 `force`。

## 配置与插件预设

- `strict-trust`：manual 信任模式；
- `chief-approvals`：只读 MCP + 待审批派发 + dsh-im 通知；
- `cloud-materials`：Google Drive / OneDrive / WebDAV 模板；
- `config-hot-backup`：自动快照配置；
- `popular-companions`：已验证兼容的
  `@xmanrui/dsh-im`、`@tencent-connect/dsh-qqbot`、`@liustack/modlens`、
  `@nanmicoder/dsh-agent-teams`，附安装命令，不自动执行安装。

预设本身是数据，不执行任意命令；插件安装仍走宿主 `pluginManager` 或人工命令。

## 配置热备

快照源是显式 allowlist：

- profile 的 `package.json`、`cordis.yml`、`cordis.patch.yml`、`pnpm-lock.yaml`、
  `pnpm-workspace.yaml`、`compatibility.json`；
- home 的 `cordis.patch.yml`；
- 鲸群状态：期望清单、锁、信任表、MCP 客户端哈希、派发请求、通知回执、对齐请求；
- `fleetBackup.files` 追加的自定义文件。

明确排除：`host-key.pem`、`.credentials.yaml`、`credentials.json`、SSH 私钥等。
符号链接、超大文件、非普通文件跳过并记录原因。

快照目录：

```text
backups/<timestamp>-<random>/
  manifest.json   # 0600
  files/0,1,...   # 0600
```

每个文件记录原始绝对路径、sha256、字节数和权限；目录 0700，保留最近 N 份
（默认 10，最大 50）。

### 自动（热）快照

`fleetBackup.auto: true` 时：

- 首次启动且没有任何快照时创建 `startup`；
- 本机清单摘要变化时最多每 60 秒创建一次 `manifest-change`；
- 失败只写 warn 日志，不影响环境采集与门控。

这是本机配置热备，不是跨机实时复制；跨机复制仍需对象存储或 SSH/Tailscale 传输。

### 校验与恢复

- `verify(id)` 校验快照自身文件哈希，不读取当前配置；
- `restorePlan(id)` 对比当前文件：`unchanged` / `changed` / `missing`；
- `restore(id, {dryRun:false, approve:true})` 前先校验快照，再自动创建
  `pre-restore:<id>` 快照，然后原子写回原路径与原权限；
- 默认 `dryRun:true`，未显式 `approve` 一律拒绝。

## 接入面

- `GET /plugins/dsh-fusion/fleet/presets`；
- `POST /plugins/dsh-fusion/fleet/presets/skills/install|uninstall`；
- `GET /plugins/dsh-fusion/fleet/backups`；
- `POST /plugins/dsh-fusion/fleet/backups/create|verify|restore`；
- MCP：`whale_presets`、`whale_backups`（可选 `id` 校验单份）；
- 面板“预设与热备”：安装/卸载 Skill、立即快照、校验；
- `ctx.get("whalePresets")` / `ctx.get("whaleBackup")` 供其他插件复用。

## 安全边界

- 备份不包含私钥与凭据值；
- 恢复只写快照记录过、且当前 allowlist 中仍存在的路径；
- 恢复需要同源认证 + 显式批准，默认只做演练；
- Skill 安装拒绝路径逃逸与未受控覆盖；
- 预设不执行 shell 命令，不自动安装第三方插件。

## 验证

- `fleet-presets.test.ts`：列表、安装、幂等、篡改检测、force 卸载、拒绝外来目录。
- `fleet-backup.test.ts`：私钥排除、校验、变更检测、演练不写、未批准拒绝、
  恢复与 pre-restore、权限保持、保留策略。
- `NativePresetsBackup.test.tsx`：Skill 安装与快照创建。

未验证：真实 DSH 进程重启后 skill provider 的发现延迟；跨机备份复制。

## 后续

1. 备份包签名与跨机复制（R2/S3/SSH）；
2. 恢复前的配置 diff 可视化；
3. 预设版本与来源锁定；
4. 对齐请求与恢复请求统一到一个“变更中心”。
