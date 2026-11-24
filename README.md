# 🐋 鲸 · Whale

鲸是 DSH 原生多机协作插件，在宿主右侧面板查看任务、主机、团队与执行证据，
上游会话与 Room / AgentTeams / AgentBus 保留自己的状态与执行语义，鲸不创建第二套权威状态。
本 native 候选默认用于任务 / 主机 / 团队 / 海域查看和证据导航。旧 FusionApp 的派发、配置、
运行与终端组件及 host API 保留在源码中，尚未全部迁入新入口；不承诺与 beta.13 UI 功能完全等价。

当前候选：**0.2.0-beta.15**，MIT，可试验的原生面板预发布。任务默认显示，海域按需打开。
[发布说明与验证范围](docs/releases/2026-11-24-beta15.md)。
当前公开预发布仍为 **0.2.0-beta.14**；历史版本 **0.2.0-beta.13**；[历史发布说明](docs/releases/2026-11-16-beta13.md)
与 [预构建包](https://github.com/muyi123567/dsh-fusion-public/releases/tag/v0.2.0-beta.13)保留。
beta.15 新增云盘连接器（读取与批准导出）、通知适配器、远端信任表、预设/热备、
环境对齐执行与统一状态诊断；安装包 SHA-256：
`d9c083ca930a3c4b9de6579107b67c5fb497668a1ea632ac11fd899898ae2ee8`。
beta.14 的 UI/来源记录保留为历史，不用旧包摘要代替 beta.15 验收。

## 原生右栏面板

选择 DSH 会话，从侧栏「鲸」或右栏添加页打开面板：

- 默认任务列表，受阻、失败与待验收优先；可搜索名称或归属、按状态筛选。
- 任务、主机、团队详情在同一面板打开；支持返回与面板内 Escape。
- 宿主管理标签、关闭和宽度，颜色与字体继承 DSH；桌面聊天区保留在旁边。
- 海域由用户主动切换，届时才加载场景与 3D。窄屏右栏可能由宿主自行切换全屏。

当前快照是 Fusion 全局来源，不是当前会话的专属列表。
缺少证据不能解释为成功；SSH 可达不等于终端登录或任务完成。
主机连接、兼容性、能力与权限分别呈现，团队成员依照 `AgentTeam.taskIds` 声明。

[产品说明](docs/design/2026-11-17-native-panel-product.md) ·
[接入规划](docs/design/2026-11-17-whale-native-panel-plan.md) ·
[原生验收方法](docs/design/2026-11-17-native-panel-acceptance.md)

## 开放接入

鲸群的目标不是封闭工作台，而是 DS-Bot 式 Bot 团队在多机上的“执行与环境一致性层”：
任务仍属于 DSH/DS-Bot 的 Session，鲸只提供跨机派发、环境清单、漂移报告和执行证据。

| 接入面 | 面向 | 形态 |
| --- | --- | --- |
| `whaleFleet` 服务 v1 | 其他 DSH 插件 | `ctx.provide` + `inject`，版本化只读/派发接口 |
| MCP 工具 | DS-Bot Bot、Claude、Codex、脚本 | 本机 loopback，默认关闭，按客户端令牌限权 |
| 标准槽位 | 宿主 UI | `sidebar.panellist`、`main`、`plugins.detail.section` |
| JSON Schema | 任意实现 | `docs/design/contracts/` 下的清单、漂移、派发契约 |

M1/M2 只读切片已实现：`whaleFleet` 服务（`contractVersion: 1`）、
`/plugins/dsh-fusion/fleet/{environment,hosts,diff}` 只读路由、面板顶部的环境条，
以及本机 MCP 的六个只读工具：
`whale_list_hosts`、`whale_host_manifest`、`whale_environment_diff`、`whale_receipt`、
`whale_doctor`、`whale_environment_plan`。诊断检测 DSH 版本、环境漂移、MCP、执行节点与
已安装的 DS-Bot、dsh-im、QQBot、Modlens；对齐计划把漂移转成带风险与重启要求的人工步骤。
面板“诊断”“对齐计划”按钮提供同一报告。
面板“保存为期望”可把当前主机清单原子写入 `expected-manifest.json`（0600），
后续 diff、门禁和对齐计划直接使用，不再需要手写期望文件。
M3 后已在执行启动中接入环境门禁与 v3 回执；配置执行作业时再增加
`whale_request_dispatch`：Bot 只能创建待审批意图，必须在面板“待审批派发”批准后才执行。
只有带 `--request` 的外部令牌才拥有该 scope。环境对齐执行只允许本机，自动执行
`install/update/enable`，必须由面板或带 `approve` scope 的运维令牌批准；失败逆序回滚，
执行后强制重采集并重新 diff，`patch/checkout/clean/credential` 仍保持人工。

```yaml
- id: dsh-fusion
  config:
    fleetEnvironment:
      directory: /var/lib/dsh-fusion/fleet
      expectedManifestPath: /var/lib/dsh-fusion/fleet/expected-manifest.json
      trustFile: /var/lib/dsh-fusion/fleet/trusted-hosts.json
      trustMode: manual
      staleAfterSeconds: 900
      secretNames: [DEEPSEEK_API_KEY]
    fleetPresets:
      skillsDirectory: /home/me/.dsh/skills
    fleetBackup:
      directory: /var/lib/dsh-fusion/fleet/backups
      retention: 10
      auto: true
    fleetMcp:
      enabled: true
      port: 8797
    fleetNotifications:
      directory: /var/lib/dsh-fusion/fleet/notification-receipts.json
      dshIm:
        botId: <dsh-im bot id>
        targetId: <dsh-im target id>
        format: plain
      webhook:
        url: https://example.invalid/dsh-fusion
        secretEnv: FUSION_WEBHOOK_SECRET
      adapters:
        - id: ops-slack
          kind: slack
          label: Ops Slack
          urlEnv: FUSION_SLACK_WEBHOOK
        - id: team-feishu
          kind: feishu
          label: 团队飞书
          urlEnv: FUSION_FEISHU_WEBHOOK
        - id: oncall-telegram
          kind: telegram
          label: On-call Telegram
          tokenEnv: FUSION_TELEGRAM_BOT_TOKEN
          chatId: "-1001234567890"
    fleetConnectors:
      directory: /var/lib/dsh-fusion/fleet/imports
      maxBytes: 67108864
      connectors:
        - id: team-drive
          kind: gdrive
          label: Team Drive
          refreshTokenEnv: GOOGLE_DRIVE_REFRESH_TOKEN
          clientIdEnv: GOOGLE_DRIVE_CLIENT_ID
          clientSecretEnv: GOOGLE_DRIVE_CLIENT_SECRET
        - id: one-drive
          kind: onedrive
          label: OneDrive
          tokenEnv: ONEDRIVE_ACCESS_TOKEN
        - id: nextcloud
          kind: webdav
          baseUrl: https://cloud.example.com/remote.php/dav/files/me
          usernameEnv: NEXTCLOUD_USER
          passwordEnv: NEXTCLOUD_APP_PASSWORD
```

`secretNames` 只记录名称是否存在，不读取值。首次采集会在 `directory` 生成 Ed25519
主机密钥；远端清单从 `directory/hosts/*.json` 只读加载，过期或无法验签一律显示为
“环境未知”，不会当作匹配。

远端主机默认必须**显式信任**：`trusted-hosts.json` 保存 hostId 绑定的公钥，
未信任、签名无效或公钥不匹配都返回 `unknown`，不能保存为期望环境。把对方的
`host-public.pem` 放到 `directory/hosts/<hostId>.pub.pem` 后，面板“主机信任”可一键信任；
也可用 `scripts/fleet-trust.mjs` 或 `POST /plugins/dsh-fusion/fleet/trust`。
`trustMode: tofu` 是可选的首见即信任模式，只应在受控网络使用；密钥轮换是新的 hostId，
旧条目需撤销。

主机加入包把“信任公钥 + 远端清单 + 期望环境”合成一次操作：源主机提供
`whale_host_bundle`（只含清单与公钥），目标主机用带 `approve` scope 的
`whale_import_bundle` 或 `scripts/fleet-join.mjs --bundle ... --trust --expected`
导入，缓存远端 manifest、固定信任并保存期望清单。加入包会校验自己的摘要、
公钥与 hostId 绑定以及清单签名，任何篡改都会拒绝。

`fleetPresets` 提供内置 DSH Skill 与配置模板：面板“预设与热备”可安装
`whale-fleet-ops`（多机运维安全顺序），并查看云端材料、Chief 审批、严格信任和热门
插件清单。`fleetBackup` 对 profile/cordis/lock 与鲸群状态做快照，明确排除
`host-key.pem` 和凭据；`auto: true` 会在清单摘要变化时最多每分钟快照一次。
备份校验、恢复演练与显式恢复见 [预设与热备](docs/design/2026-11-24-presets-backup.md)。

`fleetMcp` 默认关闭，只监听 `127.0.0.1`；浏览器 Origin 请求和非本机 Host 一律 403。
插件会给同 profile 的 `mcpManager` 注册内部只读客户端，DS-Bot Bot 因此能看到
`mcp__whale-fleet__whale_list_hosts` 等工具。新客户端先调用 `whale_status` 一次拿到
本机环境、漂移、信任、待审批、云盘、通知、预设、热备和对齐摘要，再按需展开；诊断
`whale_doctor` 会同时检查这些子系统。给 Claude、Codex 或脚本发放独立令牌：

```sh
node packages/plugin/scripts/fleet-mcp-token.mjs --file /var/lib/dsh-fusion/fleet/mcp.json --name chief
```

令牌只在创建时输出一次，文件只保存 SHA-256；`--list` 查看客户端，`--revoke <id>` 立即失效。
`fleetNotifications.dshIm` 为可选：安装并启用 dsh-im 后，待审批、批准、拒绝和失败事件
会通过 `dshIm.send` 发到指定目标；没有 dsh-im 或未配置时完全静默，不影响请求状态。
`fleetNotifications.webhook` 是另一个可选出口，POST 事件 JSON 并用
`X-DSH-Fusion-Signature: sha256=<HMAC>` 签名（secret 建议从 `secretEnv` 读取）。
`fleetNotifications.adapters` 是开放适配器列表：内置 `dsh-im`（优先使用
`sendChecked` 回执，支持 dsh-im 已接入的 Slack/Telegram/Discord/飞书/钉钉/QQ 等渠道）、
`webhook`、`slack`、`feishu`、`dingtalk`、`telegram`、`discord`。每个适配器可配置
`events` 过滤、`timeoutMs` 和独立 `id`；失败互不影响，最近 100 条只含元数据的回执写入
`directory`（0600）。面板与 `whale_notifications` 可查看状态，带 `request` scope 的
`whale_notify_test` 可发测试消息。第三方插件可通过
`ctx.get("whaleNotifications").register(definition, factory)` 注册适配器。

`fleetConnectors` 支持云盘读取与人工批准后的导出：内置 Google Drive、OneDrive、
Dropbox 和 WebDAV/Nextcloud。凭据只写环境变量名；拉取文件进入私有 `directory`
（默认 `fleet/imports`，0700/0600）。`whale_cloud_pull` 需要 `request` scope；
`whale_cloud_upload` 需要 operator-only `approve` scope，源文件必须在
`uploadRoots`（默认 imports）内，覆盖必须显式 `overwrite: true`，并返回 sha256。
删除和任意命令执行仍不开放。第三方插件可通过
`ctx.get("whaleConnectors").register(definition, factory)` 注册 provider。

设计依据：[DSH 高质量项目调研](docs/research/2026-11-22-dsh-quality-projects.md) ·
[开放多机产品设计](docs/design/2026-11-22-open-fleet-product.md) ·
[开放云盘连接器](docs/design/2026-11-23-cloud-connectors.md) ·
[开放通知适配器](docs/design/2026-11-23-notification-adapters.md) ·
[远端主机信任表](docs/design/2026-11-24-remote-trust.md) ·
[预设与配置热备](docs/design/2026-11-24-presets-backup.md) ·
[环境对齐执行](docs/design/2026-11-24-alignment-execution.md) ·
[统一状态与诊断](docs/design/2026-11-24-unified-status.md) ·
[主机加入包](docs/design/2026-11-24-host-bundle.md) ·
[契约说明](docs/design/contracts/README.md)。

## 安装与升级

从维护者提供的同一 release 下载 tarball 与 `SHA256SUMS`，核对后由 DSH 宿主安装。
beta.13 升级到 beta.14 前备份目标 profile 与 Fusion 自有状态，并保留旧包：

~~~sh
dsh plugin --profile web add ./dsh-fusion-0.2.0-beta.15.tgz
~~~

重载对应 profile，选择会话后打开「鲸」。`web` 可替换成自己的 profile 名称。
查看面板不需要开启模型或发送消息，模型写入与远程终端默认关闭。
本轮只验证隔离候选环境，未改动用户 production profile。
完整升级、companion 安装、校验与回滚说明见 [插件说明](packages/plugin/README.md)。

| 运行要求 | 版本与范围 |
| --- | --- |
| Node.js | >=24.9.0 |
| DSH 安装范围 | >=0.2.0-rc.2 <0.3.0 |
| 本轮推荐宿主 | 0.2.2-rc.5；最新 stable，已实机启动 / MCP / 执行验证 |
| 最新 alpha | 0.2.3-alpha.2；隔离启动、6 个只读 MCP 工具、签名清单、漂移/诊断与认证边界通过；未覆盖原生 UI 全量 |
| 候选宿主 | 0.2.0-rc.2 / 0.2.2-rc.1 / 0.2.2-rc.3；API 已核实存在，未全部重测 |
| AgentTeams companion | 0.1.30 |
| Room / AgentBus | 0.7.0 / 0.1.1（兼容补丁版） |

包内 recommended 为 0.2.2-rc.5，tested 为 0.2.2-rc.5 与 0.2.3-alpha.2；
verified 仅限实际启动、MCP 与环境采集范围，不覆盖真实模型、双机或全部原生 UI。
包包含已构建的 host、客户端和类型声明，运行依赖仍需网络或已有缓存。
安装范围不等于所有组合已经通过业务验收；缺少原生面板服务时会提示升级宿主。

## 验证边界

完整源码 1156 项、typecheck、27 项插件契约及既有 E2E / 审计结果保留于本轮记录。
分页按钮位置微调后，新候选已重过 build、18 项原生加载契约、13 项 package 契约与 doctor，
并通过宿主 `dsh plugin add` 更新；未宣称重新执行完整源码 suite。
r3 浏览器报告记录模型 / 任务写入尝试为 0、errors 为空，详情 Escape 与焦点返回通过。
r3 follow-up 已通过真实宿主设置切浅色 / 深色，以及关闭重开设置后的选中状态回读。
会话字号 14→15 使 composer 14px→15px，面板与原生 chrome 保持 14px，并恢复原值；
这是宿主“仅影响会话内容”的设置，跨 runtime 重启持久性未测。
当前包已通过原生 fresh profile 的真实来源与公开集合扩展检查；扩展数据明确为 DEMO。
同包 420px 任务 / 海域预览完成，无 overlay、聊天保留。修后性能为 14 pass / 0 fail / 3 pending，
无 page / console 错误、writes 0；未覆盖真实团队详情、物理 GPU、整 tab 卸载与 OS 后台。
已补充 `CHROME_PATH=/usr/bin/chromium` 配置下 E2E 3/3、skip 0；
生产与全依赖公告审计均为零命中，仅代表当前锁文件的公告检查范围。
最终包校验值、输入摘要与分组计数见 [beta.14 发布说明](docs/releases/2026-11-17-beta14.md)。

Host owner 声明不能替代系统账号隔离或成员级 ACL，writeScopes 只是提示。
真实模型任务、完整多 Session 协作、多 Host 业务与升级恢复矩阵仍待独立验收；
跨 Host fencing 租约、绑定精确代码版本的独立 reviewer 和候选补丁自改进尚未交付。
既有公开任务视图扩展契约保留，扩展对应集合视图，不是单条任务详情；
生命周期已恢复并通过上述原生加载契约及显式 DEMO 扩展运行检查；不声明所有第三方扩展兼容。
候选包身份、历史 UI 范围与未覆盖项见发布说明。
[公开来源](PUBLICATION.md)说明本仓库如何排除私人运维历史。

## 开发

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter dsh-fusion build
node scripts/doctor.mjs
pnpm --filter dsh-fusion test:package
pnpm test:e2e
pnpm audit --json
~~~

使用已授权的隔离环境验证。
[扩展文档](docs/extensions/task-views.md) · [贡献指南](CONTRIBUTING.md) ·
[安全政策](SECURITY.md) · [项目状态](docs/project/status.md)。
