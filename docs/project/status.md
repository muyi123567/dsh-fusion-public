# 🐋 鲸项目状态

## 当前候选：0.2.0-beta.15（2026-11-24）

在 beta.14 原生面板基础上新增：云盘连接器读取与批准导出、通知适配器、
远端信任表、预设/配置热备、本机环境对齐执行、统一状态与扩展诊断。
详细范围、兼容矩阵、验证摘要和边界见
[beta.15 发布说明](../releases/2026-11-24-beta15.md)。
安装包 SHA-256 与 `SHA256SUMS` 在打包后写入发布证据目录。

### beta.15 r2 重新打包与全新 profile 验收（2026-11-24）

`whale-fleet-ops` Skill 原先只覆盖早期 7 个工具，本轮补齐为全部 22 个 MCP 工具
（状态、加入包、对齐审批、预设/热备、云盘拉取与批准导出、通知），并由
`fleet-presets.test.ts` 固定工具清单，防止文档与工具集漂移。

重新打包后候选 SHA-256 为
`86eaf82e65e6f1fb0e8ffbee0c7493c8eea1a906f8d6b0796746fbdb7fd65376`。在全新
`DSH_HOME`、DSH `0.2.3-alpha.2` 默认 `web` profile 中复验：22 个工具、
`whale_status` 六子系统、2 份自动快照、`setup.mjs --verify` 全通过；
`/fleet/presets/skills/install` 返回 200 且状态 `installed`，安装后的 `SKILL.md`
含 23 处工具名。无令牌 / 跨站 Origin / GET 分别 401 / 403 / 401。
证据：`/data/openlet/evidence/dsh-fusion-release-beta15-r2-20261124/`。

安全复核（威胁模型、权限分离、路径与网络控制、本轮修复与残余风险）见
[beta.15 安全复核](../security/2026-11-24-plugin-security-review.md)。

### CI、公开 Release 与外部安装链路（2026-11-24）

新增 `.github/workflows/ci.yml`：Node 24 的 Ubuntu 与 macOS 矩阵，执行依赖安装、
core/config/host/plugin 构建、插件 520 项、客户端 449 项、根契约 68 项、
27 项插件契约、13 项 setup/package 契约、release 校验与 tarball 内容检查。
首次运行（run `45388689088`）两个平台均为 success。

新增 `.github/workflows/release.yml`：`v*` tag 校验版本、跑插件测试、打包并上传
tarball、`SHA256SUMS` 与 `PUBLIC_SOURCE_MANIFEST.json`。`v0.2.0-beta.15` 已发布为
prerelease；Release 产物 tarball 的 SHA-256
`86eaf82e65e6f1fb0e8ffbee0c7493c8eea1a906f8d6b0796746fbdb7fd65376`
与本地 r2 构建一致，`sha256sum -c` 通过。

外部安装链路实测：在全新 `DSH_HOME` 中直接
`dsh plugin add https://github.com/muyi123567/dsh-fusion-public/releases/download/v0.2.0-beta.15/dsh-fusion-0.2.0-beta.15.tgz`
安装成功，MCP 返回 22 个工具、`whale_status` 六子系统、签名与信任正常。
证据：`/data/openlet/evidence/dsh-fusion-release-remote-20261124/`。

边界：仓库仍为 `main`（旧候选）默认分支，公开 Release 位于
`feat/open-fleet-expected` 的 tag；Star / Fork 仍为 0，尚无外部采用或第三方反馈。

## 同类调研与离线复核校验（2026-11-22）

公开检索到 5 个 DSH 多机插件：dsh-fleet、Constellation、WispOps、dsh-anywhere、dsh-cow。
它们覆盖远程 DSH 切换、SSH/VPS 运维、NAT 入网和纯消息协作，但没有任务 revision 绑定、
材料回执或签名复核闭环，因此继续按既有差异点开发，不新增通用 SSH 面板或消息总线。
逐仓对照与边界见[同类调研](../design/2026-11-22-fleet-landscape.md)；只依据 README 与仓库元数据，
未审计源码或实际安装，星数和更新时间仅是 2026-11-22 快照。

签名工具新增离线 `--verify`：用公钥校验复核 JSON，并可用 `--receipt` 确认签名绑定的正是本次
task/attempt 回执；签名不符、摘要被改、未签名字段或回执不一致均非零退出。
`scripts/smoke-sign-native-execution-review.mjs` 已覆盖 v1/v2 成功校验、错误公钥、篡改摘要、
额外字段、错误回执和仅验签模式，最新运行输出 `native execution review smoke: pass`，exit 0。
该工具只证明签名、公钥与回执一致，不证明 reviewer 与执行者身份独立，也不替代真实 Host B 验收。

### DSH 内核兼容（2026-11-22）

官方 npm dist-tags：stable `0.2.2-rc.5`，alpha `0.2.3-alpha.2`。兼容矩阵已更新为
recommended `0.2.2-rc.5`，tested `0.2.2-rc.5` 与 `0.2.3-alpha.2`，rc.3 保留为 candidate。

- `0.2.2-rc.5`：Instabox 隔离 profile 完成 M2 DS-Bot Chief 工具调用与 M3 环境门禁/v3 回执实机验证。
- `0.2.3-alpha.2`：本机隔离 DSH_HOME 启动成功，插件加载无错误，MCP `8899` 的只读工具
  与 `whale_list_hosts` 环境清单/签名正常；未重跑完整原生 UI、DS-Bot 全链路或真实模型。

证据：`/data/openlet/evidence/dsh-fusion-dsh-compat-20261122/`（含 alpha 日志、工具清单、
环境返回、版本与 SHA256SUMS）。`packages/plugin/{compatibility.json,release.json}` 与
`src/compatibility.ts` 已同步；setup 契约在 Node 24 下 12 项通过。

### 最新内核复核（2026-11-23）

再次核对上游与 npm：最新标签仍为 `dsh-v0.2.3-alpha.2`，dist-tags 为 stable/next
`0.2.2-rc.5`、alpha `0.2.3-alpha.2`，没有更新内核。

用当前分支 `feat/open-fleet-expected`（`e3f7413`）重新构建并打包插件，安装进
`0.2.3-alpha.2` 隔离 profile 后复测：六个只读 MCP 工具全部出现；`whale_host_manifest`
返回 `dsh.version=0.2.3-alpha.2` 与 Ed25519 签名；`whale_doctor` 的版本、环境、
MCP 注册与服务检查为 ok；错误 digest 触发 `manifest.digest` 阻断漂移；
无令牌 / 跨站 Origin / GET 分别为 401 / 403 / 405。安装后的 `dist/index.js` 与本次
tarball sha256 一致，排除旧包冒充。

边界：未在 alpha 下验证完整原生 UI 业务流、真实模型、DS-Bot Chief 调用与门禁派发；
这些仍以 stable `0.2.2-rc.5` 的 Instabox 实机证据为准。

证据：`/data/openlet/evidence/dsh-fusion-dsh-compat-20261123/`。

### 开放云盘连接器（2026-11-23）

新增只读云盘连接器内核：目录化 provider、环境变量凭据引用、第三方命名空间注册，
以及 Google Drive、OneDrive、Dropbox、WebDAV/Nextcloud 四个内置 provider。
凭据值不进入配置、日志、清单或 MCP 返回；拉取文件写入私有 imports 目录
（0700/0600），带字节上限、文件名清理、路径穿越拒绝与 sha256 回执。

MCP 新增 `whale_connectors`、`whale_cloud_list` 和需要 `request` scope 的
`whale_cloud_pull`；HTTP 增加 `/plugins/dsh-fusion/fleet/connectors` 的目录、浏览和
拉取路由；面板新增“云盘连接器”浏览/拉取区。第三方插件可通过
`ctx.get("whaleConnectors").register(definition, factory)` 接入。

验证：插件 454 项、原生面板 69 项通过。`0.2.3-alpha.2` 隔离 profile 用本地 WebDAV
模拟服务实测：目录返回 4 个 provider 与 1 个就绪实例；`whale_cloud_list` 列出文件；
`whale_cloud_pull` 落盘 `a.txt`（3 B，0600，sha256 `ba7816bf…15ad`）；只读令牌被
`whale/scope-required` 拒绝；超限与 `../` 分别返回 `connector/limit` 与
`connector/path`，失败拉取不留下临时文件。

边界：真实 Google/Microsoft/Dropbox 账号未验证，只有协议级注入 fetch 测试；
本版全部只读，没有上传、删除或任意命令执行。

设计：[开放云盘连接器](../design/2026-11-23-cloud-connectors.md)。证据：
`/data/openlet/evidence/dsh-fusion-cloud-20261123/`。

### 开放通知适配器（2026-11-23）

把原来只支持 webhook/dsh-im 的直连通知升级为适配器系统：内置 `dsh-im`、`webhook`、
`slack`、`feishu`、`dingtalk`、`telegram`、`discord`，支持第三方命名空间注册。
dsh-im 适配器优先调用 `sendChecked(..., { receipt: true })`，保存 messageId /
conversationId；遇到 `send-result-unknown` 记录 unknown 且不自动重试。每个适配器有
事件过滤、超时、失败隔离与最近 100 条元数据回执（0600 原子持久化）。

新增 `whale_notifications`（目录/状态/最近回执）和需要 `request` scope 的
`whale_notify_test`；HTTP 增加 `/fleet/notifications` 列表与测试路由；面板新增
“通知适配器”区，可查看最近状态并逐项测试。旧 `fleetNotifications.dshIm/webhook`
自动映射为 legacy 适配器。

验证：插件 462 项、原生面板 70 项通过。协议级测试覆盖六种 HTTP 载荷、钉钉加签、
dsh-im 回执与 unknown 不重试、事件过滤、失败隔离和回执持久化。真实平台账号与真实
dsh-im 渠道尚未发送验证。

设计：[开放通知适配器](../design/2026-11-23-notification-adapters.md)。

### 远端主机信任表（2026-11-24）

远端缓存清单不再默认可信：新增 `trusted-hosts.json`，hostId 绑定 Ed25519 公钥；
未信任、签名无效、公钥与 hostId 不匹配一律 `unknown`，且不能保存为期望环境。
默认 `manual` 模式；可选 `tofu` 仅在 sidecar 公钥验签通过后固定。密钥轮换产生新
hostId，旧条目需撤销，不自动迁移。

新增 `GET/POST /fleet/trust`、`POST /fleet/trust/revoke`、只读 MCP 工具
`whale_host_trust`、面板“主机信任”与 `scripts/fleet-trust.mjs`
（`--list` / `--host` / `--revoke`）。信任表 0600 原子写入，只存公钥。

验证：插件 478 项、原生面板 71 项通过。真实 Ed25519 双钥测试覆盖未信任阻断、
显式信任后匹配、保存期望拒绝、篡改清单、sidecar TOFU、公钥不匹配与撤销。

设计：[远端主机信任表](../design/2026-11-24-remote-trust.md)。
证据：`/data/openlet/evidence/dsh-fusion-trust-20261124/`。

### 预设中心与配置热备（2026-11-24）

新增内置 DSH Skill `whale-fleet-ops`（多机运维安全顺序）、严格信任/Chief 审批/
云盘材料/热备配置模板，以及热门插件清单（dsh-im、QQBot、Modlens、AgentTeams）。
Skill 安装到 `~/.dsh/skills` 或配置目录，带文件哈希、幂等安装、篡改检测与安全卸载。

新增配置热备：profile 配置、锁文件与鲸群状态按 allowlist 快照，明确排除
`host-key.pem` 与凭据；默认保留 10 份，支持校验、恢复演练、显式批准恢复与
pre-restore 快照。`auto: true` 在清单摘要变化时最多每分钟快照一次。

接入：`GET/POST /fleet/presets`、`/fleet/backups`，MCP `whale_presets`、
`whale_backups`，面板“预设与热备”。验证：插件 487 项、原生面板 72 项通过。

设计：[预设与热备](../design/2026-11-24-presets-backup.md)。
证据：`/data/openlet/evidence/dsh-fusion-presets-backup-20261124/`。

### 环境对齐执行（2026-11-24）

新增本机环境对齐执行：只自动处理 `install/update/enable`，其余步骤保持人工。
请求必须先进入 pending，批准时重新计算 planDigest，环境变化则
`alignment/plan-changed` 拒绝执行。执行前记录 bundle 快照，失败逆序回滚
（enable 恢复禁用、install 重新禁用、update 重装旧版本），随后强制重采集并重新 diff。
状态区分 `succeeded / partial / manual-required / failed / cancelled`。

接入：`GET/POST /fleet/alignment`，MCP `whale_alignment`、
`whale_alignment_plan`、`whale_request_alignment`、带 `approve` scope 的
`whale_approve_alignment`，面板“环境对齐”。修复“仅 enabled 不同却额外生成
digest 审核”的假失败。

验证：插件 499 项、原生面板 73 项通过。`0.2.3-alpha.2` 隔离 profile 安装无害
fixture 后禁用，计划生成 `enable:dsh-align-fixture`；批准执行后 fixture 启用，
重采集 `after=match`，afterDigest 与期望一致，状态 `succeeded`；同一运行中还验证了
计划变化被拒绝。证据：`/data/openlet/evidence/dsh-fusion-alignment-20261124/`。

设计：[环境对齐执行](../design/2026-11-24-alignment-execution.md)。

### 统一状态与诊断（2026-11-24）

新增 `whale_status` 单次汇总：本机环境、drift/unknown/stale、未信任主机、待审批
派发与对齐、云盘、通知、Skill 预设、热备、信任与对齐状态，并给出 `nextActions`。
`whale_doctor` 同步扩展 `connectors/notifications/presets/backups/trust/alignment/dispatch`
检查；MCP initialize 指引改为先调用 `whale_status` 再按需展开。

接入：`GET /fleet/status`、`whale_status`、`ctx.get("whaleStatus")`。
验证：插件 502 项、原生面板 73 项通过。

设计：[统一状态与诊断](../design/2026-11-24-unified-status.md)。
证据：`/data/openlet/evidence/dsh-fusion-status-20261124/`。

### 云盘人工批准导出（2026-11-24）

云盘连接器新增上传：Google Drive multipart/PATCH、OneDrive Graph PUT、Dropbox
content upload、WebDAV PUT。MCP `whale_cloud_upload` 需要 operator-only
`approve` scope；源文件必须位于 `uploadRoots`（默认 imports）内，覆盖必须显式
`overwrite:true`，返回 sha256。HTTP 增加 `/fleet/connectors/upload`。

验证：插件 505 项、原生面板 73 项通过。实机拉取 `notes/a.txt` 后上传为
`notes/export.txt`，WebDAV 收到 3 B 且 sha256 与回执一致；`request` scope 被拒绝，
`/etc/hostname` 被 uploadRoots 拒绝，四个 provider 均显示 `upload=true`。

证据：`/data/openlet/evidence/dsh-fusion-cloud-upload-20261124/`。

### 主机加入包（2026-11-24）

新增 `whale_host_bundle` 导出本机清单+公钥+摘要，`whale_import_bundle`（approve
scope）或 `scripts/fleet-join.mjs` 一次导入：缓存远端 manifest、固定信任、保存期望。
加入包校验自身摘要、公钥与 hostId 绑定、清单签名，不包含私钥或密钥值。

接入：`GET /fleet/bundle`、`POST /fleet/bundle/import`、面板/CLI 导入。
验证：插件 519 项、原生面板 76 项通过；真实 Ed25519 导出/导入、篡改三类拒绝、
0600 文件；MCP approve scope 测试。

跨真实主机验收（2026-11-24）：Host B 在 Instabox `muse-instabox-2`、DSH `0.2.0-rc.2`
上以 beta.15 导出加入包；本机 alpha `0.2.3-alpha.2` 导入后，B 显示
`match / verified`，trust 1 条 manual，diff 匹配。证据：
`/data/openlet/evidence/dsh-fusion-crosshost-beta15-20261124/`。

真实对齐执行（2026-11-24）：Host B 改用 DSH `0.2.3-alpha.2` 后，用 fixture 制造
disabled 漂移，计划 `enable:dsh-align-fixture-b`，approve scope 批准执行，
`after=match`、状态 succeeded。另确认 `0.2.0-rc.2` 的 pluginManager 只返回部分
bundle 字段，只能作为安装范围，不应依赖 bundle 级比较/对齐。证据：
`/data/openlet/evidence/dsh-fusion-align-crosshost-20261124/`。

真实面板 UI 验收（2026-11-24）：DSH `0.2.3-alpha.2` 下首次发现所有插件路由
400/503；根因是 alpha `connection.admit` 与 stable `requestRejection` 契约差异。
修复为双契约适配、认证不可用时交给宿主 `webserver/authorize`。修复后状态、加入包、
云盘、通知、信任、预设/热备、对齐全部可见，API 全 200，页面无异常，未认证仍 401。
证据：`/data/openlet/evidence/dsh-fusion-ui-beta15-20261124/`。

推荐 stable 宿主验收（2026-11-24）：全新 DSH_HOME 安装 DSH `0.2.2-rc.5` 与
beta.15，MCP 22 工具、`whale_status` 与真实面板通过；全部插件 API 200、无页面异常，
稳定版 `requestRejection` 与 alpha `admit` 双契约均通过。证据：
`/data/openlet/evidence/dsh-fusion-stable15-ui-20261124/`。

云盘面板导出（2026-11-24）：面板列出 imports 本地材料并支持“导出”；真实 Playwright
点击后 `/connectors/upload` 200，mock WebDAV 收到 `exports/a-1.txt`，3 B、
sha256 与本地一致。证据：`/data/openlet/evidence/dsh-fusion-ui-export-20261124/`。

快速开始真实 UI（2026-11-24）：alpha 面板出现“快速开始”清单，真实点击安装 Skill、
创建快照，最终显示“快速开始 · 已完成”；全部插件 API 200、无页面异常。证据：
`/data/openlet/evidence/dsh-fusion-quickstart-ui-20261124/`。

### 生态诊断与热门插件检测（2026-11-23）

新增 `whale_doctor` 只读工具、`GET /plugins/dsh-fusion/fleet/doctor` 与面板“诊断”按钮，
检查 DSH 版本、环境清单/漂移、MCP 监听与 mcpManager 注册、客户端令牌、执行作业/节点/账本，
并检测 DS-Bot、dsh-im、QQBot、Modlens 的安装与启用状态。缺失可选插件只展示，不影响整体通过；
阻塞级问题才把 overall 置为 fail。纯逻辑测试与 MCP/路由/面板测试覆盖。

### 待审批派发（2026-11-23）

新增 `whale_request_dispatch`、`dispatch-requests` HTTP 与面板审批区。Bot 需要 `request`
scope，只能创建待审批意图；人类批准后复用环境门禁执行，失败记录错误码。请求文件 0600，
24 小时过期；内部 DSH 客户端自动拥有 read+request，外部令牌需 `--request`。

验证：插件全量 429 项、原生面板 66 项通过。

### 环境对齐计划（2026-11-23）

新增 `whale_environment_plan` 只读工具、`GET /plugins/dsh-fusion/fleet/plan` 与面板
“对齐计划”。把 bundle 缺失/版本、patch、工作区提交、密钥、运行时、provider/MCP 漂移
转换为安装/更新/启用/检出/凭据/人工复核等步骤，标注风险与是否重启；不生成任意命令、
不自动执行。未知环境只返回 unknown，不冒充 ready。

验证：插件全量 434 项、原生面板 67 项通过；双端类型检查与构建通过。

### dsh-im 通知适配（2026-11-23）

新增可选 `fleetNotifications.dshIm`：通过 `ctx.inject(['dshIm'])` 获取 dsh-im 服务，
在待审批/批准/拒绝/失败时发送短通知。默认关闭，无 dsh-im 或发送失败静默降级；
通知不含令牌、私钥或命令正文。`botId`/`targetId` 取自 dsh-im 自己的目标列表。

验证：通知格式、请求事件与 Webhook 11 项定向测试；插件全量 439 项、原生面板 67 项通过。

### 开放 Webhook 通知（2026-11-23）

新增可选 `fleetNotifications.webhook`：POST 事件 JSON，支持 HMAC-SHA256 签名、
`secretEnv`、超时与失败降级；可用于 Slack/n8n/自建网关。与 dsh-im 适配并存。
本地 HTTP 回环测试覆盖签名、payload 与不可达 URL。

### 双机 Host A → Host B（2026-11-23）

`muse-logged-in`（A）通过 Instabox API 派发到 `muse-instabox-2`（B）。B 独立运行 DSH
0.2.2-rc.5 与鲸，生成 23-bundle 环境清单；A 缓存 B 清单并以 `exact` 摘要门禁派发
`cross-host`。v3 回执含 B 环境观测，stdout `cross-host-ok` 摘要匹配，离线验签通过。
证据：`/data/openlet/evidence/dsh-fusion-crosshost-20261123/`（含 SHA256SUMS）。

边界：A 使用 B 的缓存清单，不能证明 B 在 worker 执行瞬间环境未变化；两台均为 Instabox VM。

### 期望环境一键保存（2026-11-23）

新增 `saveExpected(hostId)`、`POST /fleet/expected` 与面板“保存为期望”。清单原子写入
`expected-manifest.json`（0600），后续 diff、门禁与对齐计划直接使用；本地签名无效拒绝保存。

验证：插件全量 441 项、原生面板 68 项通过。

实机验收：`muse-logged-in` 隔离 profile 中，request scope 创建待审批请求，只读令牌被
`whale/scope-required` 拒绝，面板批准后环境门禁执行 `m4-approve`；v3 回执
`6fd9c57a...65e1` 含 environment，离线验签通过。证据：
`/data/openlet/evidence/dsh-fusion-m4-20261123/`（含 SHA256SUMS）。

### M1：只读环境清单与漂移（2026-11-22）

已实现 `whaleFleet` `contractVersion: 1` 的只读切片：`manifest()`、`host()`、
`listHosts()`、`diff()`、`panelView()`、`subscribe()`。采集只读使用
`ctx.pluginManager.listBundles()`、`ctx.profileContext`、profile/home 补丁、
`pnpm-lock.yaml`、`compatibility.json`、`ctx.llm.listProviders()` 和 `ctx.mcpManager.list()`；
首次采集在 `fleetEnvironment.directory` 生成 Ed25519 主机密钥，之后清单可离线验签。

新增只读路由 `/plugins/dsh-fusion/fleet/{environment,hosts,diff}`，沿用 DSH 认证；
原生面板顶部显示匹配/漂移/未知、环境摘要和漂移项。没有期望清单、远端清单过期、
签名验证失败都显示“环境未知”，不回退为匹配；M1 不自动安装、不修改 profile、不读密钥值。

验证：插件 fleet 定向 24 项、插件全量 401 项、原生面板 61 项、`tests/package.test.ts` 8 项通过；
插件与 client 类型检查、插件 build、client vite build 通过。真实双机、远端公钥信任表和
自动对齐仍未交付。

### M2：本机 MCP 只读工具（2026-11-22）

已实现 `fleetMcp`：本机 Streamable HTTP、POST-only、无 MCP 会话；带 Origin 头 403，
Host 必须 loopback，Bearer 令牌按客户端校验。`mcp.json` 只存 SHA-256（0600），
内部客户端每次激活轮换；`packages/plugin/scripts/fleet-mcp-token.mjs` 创建/列出/撤销外部客户端。

四个只读工具：`whale_list_hosts`、`whale_host_manifest`、`whale_environment_diff`、
`whale_receipt`。插件通过 `ctx.mcpManager.register('whale-fleet', ...)` 注册给同 profile 的
DS-Bot Bot 与 DSH Agent；没有 mcpManager 时仅外部客户端可用。

验证：MCP 存储/HTTP 回归 9 项、插件全量 410 项通过；插件类型检查与构建通过。
实机验收在 `muse-logged-in`（InstaBox `m_agqvx5ujg4lghpt2asdd7sfg6y`）的隔离 profile
`m2-open-fleet` 完成：DSH 0.2.2-rc.5、DS-Bot 0.3.9、鲸提交 `bb529f2`；Chief 看到四个
`mcp__whale-fleet__*` 工具并调用 `whale_list_hosts`，回复了真实 hostId。开发机无模型密钥，
因此用确定性 mock 适配器驱动 Chief；工具链真实，模型推理为测试替身。证据：
`/data/openlet/evidence/dsh-fusion-m2-20261122/`（含 screenshot、tools、401/403/405/200、SHA256SUMS）。

### M3：环境门禁与回执绑定（2026-11-22）

原生执行启动支持 `environment: { hostId, requireDigest, policy }`。门禁调用 `whaleFleet.diff`：
`exact` 只放行 match，`compatible` 放行无 block 的漂移，unknown/不可读/未配置一律拒绝。
attempt 保存控制面观测；同一 request 重试复用，改变要求为 attempt-conflict。

回执新增可选环境观测并使用 v3 域（含 materials 与 environment），v1/v2 兼容；签名复核绑定
该回执摘要。面板可读取本机环境、填写主机/摘要/策略并随启动发送。签名工具与 smoke 覆盖
v3 及环境篡改失败。

实机验收：Instabox `muse-logged-in` 隔离 profile 中，真实 AgentTeams `task-2` + loopback SSH
`m3-local`；错误摘要 `409 environment-drift`，正确摘要 `202`，exit 0，stdout `m3-v3-ok` 摘要匹配；
v3 回执 `a7971cf4...96bc` 含 environment，离线验签 `verified=true`、`receiptBound=true`。
证据：`/data/openlet/evidence/dsh-fusion-m3-20261122/`（含 SHA256SUMS）。

验证：插件全量 415 项、原生面板 63 项、v1/v2/v3 签名 smoke 通过；双端类型检查与构建通过。
真实远端清单采集、worker 内部环境证明、双物理机与自动对齐仍未交付。

## 开发分支：协作上下文与工作台候选（2026-11-20）

本轮从公开 main `db0cfad` / beta.14 继续开发，尚未提交、推送、发布或替换 production 入口。
已补原生与 legacy 任务正文的无损投影，原生详情展示负责人、修订、就绪三态、
写入范围警告和预期证据；不据此推断执行授权、成员关系或验收通过。
恢复账本改为保留全部非终态，仅终态历史使用最近 200 条配额，回归覆盖磁盘恢复后的容量准入。

独立 `workbench-preview.html` 提供横向全景、海域加任务托盘、任务优先三个交互候选。
候选全部采用固定合成数据，周边聊天仅作布局示意，无执行后端。
用户随后选定第三版“任务优先”的结构，同时明确否决旧稿美感，要求先重设计并完成独立自审。
用户已基本认可新的静态方向，并要求加入快速展示动画；设计稿与审查依据见[任务优先重设计 brief](../design/2026-11-20-task-first-design-brief.md)。
独立 `design-study.html` 已完成 r1 否决 → r2 重排 → r3 精修 → r4 文字对比修复，可提交用户评审。
新鲜验证为新增 8 项回归、client build（含类型检查）及 13 组浏览器检查；page / console errors 和写请求均为 0。
48 组明暗文字token/阅读底色组合的最小对比为4.592:1；r4浅色新图独立复看未破坏已通过的视觉层级。
420px 首任务起点 126px，常规详情实质证据阅读区起点约 493px；420 / 560 / 850 容器与明暗主题已看图。
范围、截图、迭代否决及通过依据见[设计自审](../../design-qa.md)；旧 1194 项全套结果不冒充此次新设计的重跑。
用户基本认可静态方向后，追加前端快速展示：独立稿提供约15秒一次性导览，支持暂停/继续/重播，
人工操作退出；减动态模式改为手动步骤。已修启动列表位置、键盘焦点、冗余滚动及工具栏横跳。
新增导览回归与原任务阅读回归合计14项通过；build含类型检查通过；另6组动效浏览器检查和13组基础检查通过。
实际浏览器短预览及420浅色/560深色截图已保存。动画只讲解合成任务与证据，不演成真实执行或成功。
真实 DSH 原生入口和当前已发布的 beta.14 不因该预览改变。

原生执行纵切片已接入候选 native panel：从 DSH 原生 task 投影读取当前 revision，操作员只能选择
allowlisted 作业和已配置 worker；Fusion 持久化 execution intent，经既有 FleetRouter/SSH adapter 派发，
按精确 worker task 回读终态并生成 stdout/stderr 字节摘要、命令摘要、dispatch fingerprint 和 receipt SHA-256。
签名复核 JSON 已由配置 reviewer key 签名并导入，验证 review 绑定当前 task、attempt 和 receipt。系统尚未将 reviewer key
身份关联到 DSH authenticated actor 或 executor/operator，因此签名有效不等于系统已证明审核者独立；原生面板现明确显示“签名复核通过”及此边界。
另加服务端终态门禁，completed/cancelled task 不再因 ready 标志被重新派发；新增 native execution 回归 17 项、
client execution 回归 12 项，类型检查和 client build 通过。

继续推进的版本化材料回执已落到候选源码：材料作业可固定 code/input/runtime/config 与 artifact 摘要，SSH worker 为每个 attempt
创建私有 workspace，并在终态后从同一 worker 受限读取实际文件字节；路径穿越、符号链接、超限文件、工作区身份或摘要不匹配均保持未确认。
材料回执使用 v2 digest，签名脚本同时兼容 v1/v2。当前这条材料门禁已有本机 provider 回归、worker 协议回归和 24 项原生执行回归，但本轮没有把现有
loopback 固定文本证据改写成材料 v2 或双机通过；真实 Host B、固定 checkout/input/runtime、真实 artifact 与 reviewer 身份仍待授权和现场证据。

本轮继续收紧了三个复核与恢复边界：作业撤销某执行节点后，该节点旧 review 会变为过期；账本拒绝普通作业携带材料回执，也拒绝材料作业缺失或篡改材料回执；SSH 回报的 workspace 绝对路径须与该 worker task 的预期目录一致。派发前 reservation 以 `reserved` 持久化，来源短暂不可读时可用同一 request、attempt、worker task ID 和 fingerprint 恢复；进入 `may-have-been-sent` 后按不确定处理，不盲目再次执行。该改动有定向回归，最终结果待本轮统一重跑。

本次真实执行证据只来自当前机器上的 `127.0.0.1` SSH loopback 与固定文本合成作业；配置明确 `loopbackOnly: true`，
因此不称为真实双机或业务验收。宿主 1280px viewport 的右栏拖拽实际受宿主最小宽度约 600px 限制，旧脚本的 420px 断言
应视为宿主契约不匹配；Fusion 自身 420/560px 容器回归仍保留。模型目录/Provider 元数据 POST 与真实聊天/任务写入分开计数，未发生
聊天消息、模型调用或未授权任务派发。真实第二台 Host、其 SSH 凭据/known_hosts、跨机 workspace/产物版本证据尚未获授权，仍是下一道门禁。
仓库配置中多节点只是示例；不能据此推断有可用或获准的 Host B。现有任务执行接口每个 attempt 明确绑定单 worker，Fusion 不新增第二套调度器；真实 Host B 的任务、材料 v2 回执和另一位 reviewer 的现场复核仍需一次获准的双机运行。当前 DSH 认证路由只确认会话有效，签名导入中的 reviewerId 仍是声明值，因此系统尚不能证明执行者与审核者为不同身份。

本次最终材料与恢复补丁的新鲜定向验证为：插件 execution/FleetRouter/routes 119 项、SSH/worker 76 项、原生执行面板 12 项；
插件与 Host 类型检查、插件 client build、release package/setup 契约 13 项及 v1/v2 签名工具 smoke test 均通过。
对应当前未发布候选 tarball SHA-256：`09309890ba49e531b052ed5441d3a759a52b6642e07eb5207cd4551f37e86fee`。
这组结果验证候选代码与包契约，不包含真实 Host B 运行或业务验收。

本轮源码 1194 项在单 worker、显式 30 秒单测预算下通过（root 68、core 33、config 3、
client 397、host 345、plugin 348）。默认 5 秒运行中，两项既有动画穷举测试超时；
完整同步循环在本机实测超过默认预算，保留原始失败记录，没有修改断言、采样范围或项目默认配置。
构建、类型检查、doctor 29、插件契约 27、包契约 13、原生加载契约 18 及既有 E2E 3/3 通过。
合成前端完成 1440 / 900 / 420、明暗、筛选、证据、草稿保留、IME、海域隔离/重试及减动画检查。
这些结果不代表真实宿主升级、多 Host 写入、物理 GPU 或生产验收。

[架构与产品提案](../design/2026-11-20-collaboration-control-plane.md) ·
[本轮实施计划](../superpowers/plans/2026-11-20-whale-context-and-design.md)

## 历史候选：0.2.0-beta.14

2026-11-17，候选入口已接入 DSH 原生右栏，默认任务，提供主机、团队与按需海域。
任务、主机和团队详情在同一面板内导航；标签、关闭和宽度由宿主管理，主题与字体继承宿主。
当前快照属于 Fusion 全局来源，不是当前会话专属数据；团队归属采用 `AgentTeam.taskIds`。
复用上游任务与协作原语，不创建第二套调度或验收权威状态。
本版是可试验的原生面板预发布，默认用于查看与证据导航；旧 FusionApp 的派发、配置、
运行与终端组件及 host API 保留，尚未全部迁入新入口，不承诺与 beta.13 UI 完全等价。
已发布 beta.13 包与用户 production 保持不动。既有任务视图扩展契约保留，
集合视图接入的生命周期已恢复并通过 18 项原生加载契约及本次显式 DEMO 扩展实际运行检查，
不改成单任务详情扩展，也不删除既有承诺。

当前发布候选 SHA-256：`3a317257ceb5e4f77b756c9e72a63530e56e73146109ecd5613163385139ee26`，已公开为 GitHub 预发布。
海域分页按钮已移至左侧组中，避免 AgentBus 固定右侧 capsule 拦截；仅调整按钮位置。
新包已由官方 `dsh plugin add` 更新，退出 0，模块 / schema / activation 错误标记均为 false；
build、18 项原生加载契约、13 项 package 契约与 doctor 重验通过。
本轮完整源码测试仍为 1156，typecheck、27 项插件契约及其它既有门禁结果继续保留，
未将此次最小复验写成重新跑过完整 suite。
源码分组：root 68、core 33、config 3、client 378、host 337、plugin 337，合计 1156。
分页位置调整前，CUE / Instabox 的全部 packages 输入摘要一致：
`26825881c3c02564d8425cc1484b1605f32e9420d7da55ffd8e4873479e46cf4`。
该历史摘要不作为新候选输入身份；新摘要待来源收据更新，不替代完整公开来源清单或运行验收。
既有 E2E 在 `CHROME_PATH=/usr/bin/chromium` 下 3/3 通过、skip 0；
生产依赖审计退出 0，58 项依赖的五级 vulnerabilities 均为 0。
全依赖 `pnpm audit --json` 同样退出 0，dependencies 58、dev 221、optional 56、total 279，
五级 vulnerabilities 均为 0；仅表示当前锁文件公告检查无命中，不代表源码零漏洞。

父路回读的 r3 实际 UI 报告记录：modelRequests 0、taskWrites 0、errors 空，
realStateResponses 3，Escape 返回和焦点恢复均为 true，入口为 r3 footer launcher。
已有 384 / 420 窄面板的任务、详情、主机、团队、海域截图。
r3 follow-up 报告为 passed，仍对应 r3 包，modelOrTaskWriteAttempts 0、errors 空。
真实 native-settings 切浅色 / 深色与同一 runtime 内关闭重开设置后的选中状态回读已通过。
会话字号 14→15 使 composer 14px→15px，面板与原生 chrome 保持 14px，并恢复原值；
设置明确只影响会话内容，跨 runtime 重启持久性未测。
任务→主机 / 团队→原任务 / 列表、Escape 后详情消失及原行焦点、证据 href 与新窗口属性、
关闭重开后的 session / tab 关联及未发送草稿保留均有记录；证据 URL 未打开。
较早 `8447…` 候选在 `ui-qa-final-parent` 通过 fresh profile 来源提示与显式 DEMO 集合扩展，
420px push 与聊天共存、6 task / 3 node topology、dispatch / cancel 未提供；四个 chunk 字节匹配，
错误 / 写入计数 0，前后实际 tasks 0。同包 `ui-qa-final-previews` 的任务 / 海域截图
`QA_EXIT=0`、writes 0、pageErrors 0，无 overlay、聊天保留。上述均为历史候选结果。
当前 `3a317…ee26` 候选的三组 `ui-qa-publish-*` 均已完成，全部 `QA_EXIT=0`、`DSH_STOPPED=True`。
真实来源 + 公开扩展为 passed；修后性能 / 分页为 14 pass / 0 fail / 3 pending，
无 page / console 错误、writes 0；420px DEMO 任务 / 海域截图完成，无 overlay、聊天保留。
三个 pending 为真实团队详情、物理 GPU、整 tab 卸载与 OS 后台行为；不将其写为已覆盖。
当前包按原生 fresh profile、真实来源与显式 DEMO 扩展 / 场景范围验收；
r3 主题、详情和其它尺寸是先前独立记录，未在当前包全量重跑。

主机来源不可用与合法空板的区分已在 `e9f3910` 实现，公开 taskView 生命周期已在
`e3c7de1` 恢复。本次三组最小实际复验已完成；新包来源摘要与公开证据由维护者统一归档。
兼容元数据已更新为 recommended / tested 仅 0.2.2-rc.3，candidates 为
0.2.0-rc.2 / 0.2.2-rc.1，安装范围不变；更新后的源码与包契约已通过。
rc.3 verified 仅依据隔离启动 / 原生 UI 范围；旧宿主 API 已核实存在，不标 unsupported，
但 beta.13 的 rc.1 历史 verified 不覆盖 beta.14 与旧宿主的运行组合。
最终包 SHA-256、输入摘要与逐项边界见 [beta.14 候选发布说明](../releases/2026-11-17-beta14.md)。

beta.13 → beta.14 通过宿主安装并重载目标 profile，升级前备份并保留旧包。
面板使用无需开启模型，模型写入和远程终端仍默认关闭；本轮没有 production 改动。
SSH 可达不代表 PTY 已登录，任务完成或子代理空闲不代表独立验收通过。
真实模型任务、完整多 Session / 多 Host 业务协作、升级恢复矩阵仍待验收；
fencing 租约、绑定精确代码版本的独立 reviewer 和候选补丁自改进仍属后续工作。

[产品说明](../design/2026-11-17-native-panel-product.md) ·
[原生验收方法与待覆盖项](../design/2026-11-17-native-panel-acceptance.md)

## beta.13 历史记录

2026-11-16 的 beta.13 完成三版布局比较及当轮截图、安装与契约验证，
历史产物和哈希见 [beta.13 发布说明](../releases/2026-11-16-beta13.md)。
这些记录属于旧安装包，不作为 beta.14 原生右栏的通过证据。

后续独立「鲸入深海」动态原型及鲸群场景预览使用显式合成情境，
不代表真实多集群执行或当前原生面板已经验收。
原始比选、提示词与验收资料继续保留在 docs/design；当前产品以原生面板候选为准。

公开预发布：https://github.com/muyi123567/dsh-fusion-public/releases/tag/v0.2.0-beta.14
