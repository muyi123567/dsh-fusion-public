# DSH 高质量项目代码级调研

日期：2026-11-22。范围：只读公开源码，不安装、不执行、不评价其线上服务。
星数为当日 GitHub API 快照，容易被刷量，只用于排序，不作为质量证据。

## 调研对象与坐标

| 仓库 | 快照 | 读取重点 |
| --- | --- | --- |
| [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) | `4b399c3` / 2026-11-22 | `docs/architecture.md`、`docs/api-gateway.md`、`packages/boot/app-boot`、`packages/boot/plugin-manager`、`packages/mcp/mcp-manager`、`packages/client/ui-slots` |
| [`Fei2411/DS-Bot`](https://github.com/Fei2411/DS-Bot) | `d104d9c` / 2026-11-22 | `ds-bot/plugin.js`、`ds-bot/index.js`、`ds-bot/src/host/{entry,mcp-server,home-lock,store,tools}.js`、`ds-bot/cordis.patch.yml`、`docs/plans/2026-11-20-mcp-access.md` |
| [`xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im) | `0694642` / 2026-11-22 | `docs/client-integration.md`、`plugin-src/host/index.mjs`、`plugin-src/client/index.js`、`package.json` |
| [`tencent-connect/dsh-qqbot`](https://github.com/tencent-connect/dsh-qqbot) | `63abb82` / 2026-11-21 | `package.json` 的 `dsh` 清单、`cordis.patch.yml`、`lib` 入口形态 |
| [`liustack/modlens`](https://github.com/liustack/modlens) | `e42fc49` / 2026-11-15 | `package.json` 的 `dsh.bundle` / `dsh.client` / exports、`cordis.patch.yml` |

## 结论摘要

1. **DSH 没有“特权核心”。** 模型适配器、工具注册表、会话日志、Agent 循环本身都是插件；
   扩展方式是挂载 Cordis 插件，注册是随插件卸载而回滚的 effect。
2. **DS-Bot 真正的设计不是“聊天界面”，而是四个约束：** 每个 Bot 是一个 DSH root Session；
   团队状态只有一个写者（home lock）；外部 Agent 只能通过受限 MCP 通道说话；设备远程走
   X25519 身份 + 端到端加密中继。
3. **高质量插件的共同模式：** 版本化服务契约（`contractVersion`）、生命周期绑定注册、
   默认关闭、标准槽位、可选依赖、明确来源标记、不建立第二套权威状态。
4. **鲸群当前缺的不是执行能力，而是公开契约。** 我们已有任务、主机、回执、签名复核，但
   没有 `ctx.provide` 的服务接口，没有 MCP 工具面，没有可供其他主机比对的标准化环境清单。
5. **DSH 没有现成的多机环境一致性实现。** 但 profile 目录、`dsh.profile.bundles`、
   `cordis.patch.yml`、`compatibility.json`、`ctx.pluginManager.listBundles()` 已经提供了
   足够的事实源，可以在不新增权威的前提下做“环境清单 + 漂移报告”。
6. **鲸群的差异化机会：** 把现有“执行证据”扩展为“环境证据”——回执不仅绑定代码/输入/产物，
   还绑定该主机当时的环境摘要；复核人才能判断两台机器是否在同一个可复现环境里。

## 一、DSH 的原生扩展模型

### 1.1 Cordis：服务、事件、可回滚 effect

`docs/architecture.md` 明确写道：Cordis 是 DSH 之下的框架，插件向共享 context 贡献服务、
类型化事件和可回滚 effect；包括模型适配器、工具注册表、会话日志和 Agent 循环在内，每一部分
都是可替换插件，“没有需要打补丁的特权核心”。这决定了我们的接入方式必须是**并列挂载**，
而不是修改宿主或绕过插件生命周期。

### 1.2 Profile 与 Bundle：分发的正式单位

- profile 位于 `$DSH_HOME/profiles/<name>`，由有序 bundle 层 + 自己的 `cordis.patch.yml`
  组成；bundle 通过 `package.json` 的 `dsh.bundle.patch` 声明补丁文件。
- 每个插件可以在 `package.json` 的 `dsh.client` 中声明浏览器半边、注入的客户端包、
  `platform` 和 `immediately`。
- `--dump-config` 可导出实际组合；`compatibility.json` 保存精确版本豁免；插件管理器负责
  安装、更新、启用/禁用与版本兼容检查。

事实证明，DS-Bot、dsh-im、dsh-qqbot、modlens 与鲸都采用同一套清单：

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["..."], "immediately": false },
    "compatibility": { "dsh": ">=0.2.0-rc.2 <0.3.0" }
  },
  "exports": { ".": "...", "./client": "..." }
}
```

这不是某家私有格式，而是 DSH 生态的事实标准；鲸已经符合，但没有把“可被他人组合”写进产品契约。

### 1.3 插件间服务：`ctx.provide` + `inject`

dsh-im 给出了最清晰的可复用范式：

- 客户端半边 `ctx.provide('dshImClient', Object.freeze({ version: 1, render, setSettingsVisible, settingsVisible }))`
  （`plugin-src/client/index.js:698`）。
- 宿主半边 `ctx.provide('dshIm', Object.freeze({ contractVersion: 1, ... }))`
  （`plugin-src/host/index.mjs:140`）。
- 消费方在自己的插件里 `inject: ['dshImClient']`，先检查 `version === 1`，用宿主共享的
  React 实例渲染返回的 element；provider 卸载后，旧引用必须返回 `null` / `false` 并忽略写入。

这套契约的关键不是 API 名字，而是四条纪律：

1. 显式版本号，不是软件版本；
2. 能力缺失时优雅降级，不阻塞旧宿主；
3. 注册与清理都挂在 provider 生命周期上；
4. 消费方不复制 provider 的状态，也不另建 React/状态树。

### 1.4 槽位：标准 UI 接入点

- `sidebar.panellist`：左侧导航的主面板入口（dsh-im 用它提供“IM机器人”）。
- `main`：主区域面板。
- `settings.section`：设置页分区。
- `plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section`：插件详情页的
  操作、徽标和分区，`subject` 会带上 bundle / row / item 的真实安装与启用事实。

这些槽位是声明式的、有生命周期和所有权校验的；直接操作 DOM 或另起全屏后台不属于原生接入。

### 1.5 Typert Remote：类型化 RPC

`docs/api-gateway.md` 说明：业务服务用 `@Remote` / `@RemoteScope` 标记暴露给客户端的方法，
构建期生成 Host 与 Client 契约；未标记的方法不会进入客户端类型或运行时贡献。它复用
Connection RPC 与 `/api`，带查找参数、资源访问控制和流式方法。

这意味着鲸的 HTTP 路由不是唯一选择：如果希望其他 DSH 客户端插件以类型安全方式调用，
应把稳定的读接口逐步迁到 Remote 命名空间（例如 `ctx.remote.whale`），同时保留现有
`/plugins/dsh-fusion/...` 路由作为兼容面。

### 1.6 MCP Manager：插件自带的 MCP 服务

官方 `packages/mcp/mcp-manager` 允许插件在生命周期内注册一个 MCP 服务器：

```ts
export const inject = ['mcpManager']
ctx.mcpManager.register('example', {
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer ${credential:EXAMPLE_TOKEN}' },
})
```

注册是 effect：插件禁用/卸载时服务器被卸载、工具被撤回；名称与配置项不能冲突；状态可通过
`list()`、`restart()`、`probe()` 观察。对鲸群而言，这是把“多机能力”暴露给**同 profile 内
所有 DSH Agent（包括 DS-Bot 的 Bot）**的最短路径，不需要改 DS-Bot。

### 1.7 Plugin Manager：环境事实源

`BundleInfo` 已包含：`name`、`version`、`enabled`、`installed`、`availability`、
`source`、`official`、`optional`、`removable`、`update`、`rows`、`overrides`、`error`。
配合 `profileContext` 的 profile 位置和启动 bundle 名，可以生成稳定的环境清单，而不必
自己扫描 `node_modules` 或猜测安装状态。

### 1.8 认证与连接边界

DSH 的 `connection.requestRejection(headers)` 决定请求是否被宿主认证；鲸现有路由已使用它，
并叠加同源 mutation 与 JSON content-type 检查。插件不应自行发明登录态；若要对外暴露本地
API，应像 DS-Bot 一样默认关闭、只监听 loopback、校验 Host/Origin、按客户端发可撤销令牌。

## 二、DS-Bot 拆解

### 2.1 分发形态

- 独立桌面应用 + 可作为 DSH 插件安装（`ds-bot` npm 包）。
- `ds-bot/cordis.patch.yml` 只做三件事：插入 `bot` 行、插入 `web-search-auto` 行、
  关闭 DSH 自带 `ui-settings-general`（由 DS-Bot 的设置壳接管该座位）。
- 宿主入口 `plugin.js` 只导出 `name` / `inject`，在 `apply` 内动态导入 `index.js`，
  让宿主模块加载失败只影响激活，不拖垮浏览器半边。

### 2.2 状态模型：Bot 就是 root Session

`ds-bot/index.js` 顶部写明：每个 Bot 是一个普通 DSH root Session；roster、rooms 和
bot-to-bot 交换日志放在 `DSH_HOME` 下的一个 JSON 文件里，从而“不需要新的 Session 事件类型”。

这是很重要的克制：DS-Bot 没有发明第二套会话存储，也没有要求 DSH 增加事件；它把团队元数据
放在插件自有文件，把对话留在 DSH Session。鲸群应沿用同一原则：**任务权威仍在上游，鲸只保存
跨机 attempt 与证据关联。**

### 2.3 单写者：home lock

`ds-bot/src/host/home-lock.js` 用 `state.lock`（pid + host + 随机 token + mtime 心跳）保证
同一 `DSH_HOME` 只有一个写者；第二个宿主只读。它明确处理了 pid 复用、心跳过期、token 易主
和进程退出清理。`store.js:52` 在打开状态文件时取得该锁。

鲸群的多机版本不能直接复制文件锁，但必须复制它的语义：**同一工作区/同一团队状态只允许一个
有效写者；租约必须有单调 token、过期与撤销，并且“失去锁”要能被观察到。**

### 2.4 工具作用域：只给 Bot 会话

`ds-bot/src/host/tools.js:1022` 说明团队工具注册在“每个 Session 自己的 scope”，不进入全局层：
既可以避免与同名全局工具冲突，也避免普通会话意外获得派发能力。它还逐组屏蔽 DSH 自带委派
工具，避免用户看不见、停不掉的子 Agent。

对鲸群的直接启示：`fleet_dispatch` 这类高权限工具不能全局注册给所有会话；至少应按
“协调者 Session / 普通 Session / 只读面板”分级，并用 DSH 的 scope 与 approval 机制约束。

### 2.5 MCP 访问：外部 Agent 的唯一正式通道

`docs/plans/2026-11-20-mcp-access.md` 与 `src/host/mcp-server.js` 的共同设计：

- 默认关闭；只有持有团队锁的宿主监听；只绑定 `127.0.0.1`，默认端口 8797。
- Streamable HTTP，但只用 POST + JSON 应答，不建 MCP 会话；批量请求逐条处理。
- `Origin` 头存在即 403（浏览器不能调用）；Host 必须是本机，防 DNS rebinding。
- 每个客户端一个 Bearer token；`mcp.json` 只存 SHA-256，删除客户端立即失效。
- 新客户端默认只能找 Main Bot，群聊默认没有；隐私 Bot 永远不在范围。
- 只有 7 个工具：`list_bots`、`list_groups`、`send_to_bot`、`send_to_group`、
  `wait_for_reply`、`read_chat`、`list_waiting`；审批、设置、密钥、建删 Bot 一律不暴露。
- 发出的消息带 `[Sent by the external agent "..."]` 来源标记；`requestId` 为
  `mcp:<client>:<uuid>`；来源只是信息，不是授权。
- 长任务用 `after` 游标轮询；`wait_for_reply` 最多 50 秒，避免 MCP 客户端 60 秒超时。

这是“开放但不放权”的范本：接口足够让外部 Agent 协作，边界足够让人类保留审批与密钥。

### 2.6 设备链路：身份与加密，而不是明文转发

`link/README.md` 与 `docs/plans/2026-11-17-web-remote.md` 描述：手机与电脑各持 X25519
身份密钥，device id 由公钥派生；配对码在端到端加密握手内发送，Relay 只转发密文；浏览器
作为额外设备，使用同一 E2E 链路，并通过 default-deny 白名单限制可调用端点。

对多机环境一致性而言，这提供了两个可复用件：**主机身份 = 公钥派生 ID**，以及
**清单/回执可签名、可验证来源**。鲸群不需要复制整条手机链路，但应采用同样的身份模型。

### 2.7 该学与不该学

该学：

- 版本化、可撤销、默认关闭的外部接口；
- 来源标记与请求 ID；
- scope 化工具，而不是全局放权；
- 单写者语义与失败可见性；
- 把复杂能力藏在“少量稳定工具”后面。

不该照搬：

- 解析 DS-Bot 私有 `state.json` 当集成 API（它不是公开契约，随时可变）；
- 把外部 Agent 当团队成员（DS-Bot 明确把它当“用户授权的一个渠道”）；
- 为了“多机”另造一套消息总线或第二套任务状态。

## 三、dsh-im：客户端服务契约的范本

`docs/client-integration.md` 展示了一个成熟插件如何对外提供 UI：

- 导出可选服务 `dshImClient`（`version: 1`），提供 `render()`、`setSettingsVisible()`、
  `settingsVisible()`；
- 宿主用**共享 React 实例**渲染，不缓存 element，不重复打包 React；
- 只有新入口和内容都可用后才隐藏旧设置入口；退出集成时恢复；
- provider 卸载后旧引用 `render()` 返回 `null`，写入无效；
- 使用标准 `sidebar.panellist` / `main` / `plugins.detail.actions`，不依赖桌面端专用 API；
- 老宿主缺少 `ctx.provide` 时只跳过新服务，原设置页照常工作。

这套“可选服务 + 版本 + 降级 + 清理”的写法，应直接用于鲸群的 `whaleFleetClient` 或面板嵌入。

## 四、dsh-qqbot / modlens：打包与兼容纪律

两者都把 `dsh.bundle.patch`、`dsh.client`、`./client` 导出和兼容矩阵写进 `package.json`；
qqbot 还声明了具体 DSH release 的兼容状态与说明。它们说明：生态里的“可安装”不仅是能跑，
还要让宿主在安装前判断平台、版本、客户端注入和补丁层是否匹配。

鲸目前的清单已包含 bundle/client/compatibility，但没有把“对其他插件提供什么”写进清单或文档。

## 五、高质量插件的共同模式

| 模式 | 证据 | 对鲸群的要求 |
| --- | --- | --- |
| 版本化服务契约 | dsh-im `dshImClient` v1 / `dshIm` contractVersion 1 | 提供 `whaleFleet` v1，显式 `contractVersion` |
| 生命周期绑定 | `ctx.effect`、`ctx.provide`、mcpManager registration | 所有注册可随插件卸载回滚，测试覆盖 |
| 默认关闭 | DS-Bot MCP、鲸执行端点 | 新外部接口默认关闭，面板内显式开启 |
| 最小权限 | DS-Bot 7 个工具、隐私 Bot 排除 | 读/派发/管理分级，审批不外包 |
| 不建第二权威 | DS-Bot Bot=Session；鲸 task=上游 | 只保存关联与证据，不复制任务正文作为权威 |
| 标准槽位 | dsh-im 使用 sidebar/main/settings/detail | 不操作宿主 DOM，不另起全屏后台 |
| 可解释来源 | `[Sent by ...]`、requestId | 每次跨机动作带 origin、actor、attempt、digest |
| 失败可见 | home-lock 失锁、mcp 清理失败保留行 | 漂移、过期、不确定状态必须显式呈现 |
| 兼容矩阵 | qqbot `dshReleases` / `profiles` | 发布时标注 DSH 版本、profile、平台 |
| 机器可读契约 | Typert 生成、JSON schema、MCP inputSchema | 发布 `contracts/*.schema.json` |

## 六、对鲸群的直接判断

1. 我们已经有别人没有的“任务—attempt—材料—签名复核”链条，但它目前只在鲸自己的 UI 和
   HTTP 路由里成立，其他插件无法以稳定方式使用。
2. 要成为“DS-Bot 的多机协作另一种版本”，最有效的不是复制 Bot UI，而是让**任何 DSH Agent
   （包括 DS-Bot 的 Bot）都能通过 MCP 工具调用鲸群能力**，并把结果回写到同一任务/证据链。
3. 多机环境一致性应作为独立产品面：环境清单、漂移报告、环境门禁、环境回执。它既能服务鲸群
   自己的派发，也能被其他插件作为服务调用。
4. 开放不等于放权：默认本地、默认关闭、按客户端令牌、读接口优先、写操作需审批。

## 七、边界

本调研只证明上述仓库在指定提交上存在这些代码与文档，不证明其运行时行为、安全性或线上可用性。
鲸群的新契约必须通过自己的测试与真实宿主验证后才能称为可用；本文件不构成发布声明。
