# 开放云盘连接器

日期：2026-11-23。代码：`packages/plugin/src/cloud-connectors.ts`、
`cloud-providers.ts`、`fleet-connector-routes.ts`，面板
`packages/client/src/features/native-panel/NativeCloudConnectors.tsx`。

## 目标

把 DS-Bot 连接器里最有价值的三件事带进鲸群：

1. **目录化的 provider**：服务是数据，不是散落在代码里的 if/else；
2. **凭据与配置分离**：配置只写环境变量名，令牌只在校验/请求时读取；
3. **开放注册**：其他 DSH 插件可以注册自己的连接器，不必改鲸群源码。

鲸群不做 DS-Bot 那种“把所有远程 MCP 都挂进来”的通用网关。当前只做只读云盘，
因为多机协作最缺的是“把同一份材料从云端可靠地拿到执行主机”，而不是再复制一个
MCP 市场。

## 模型

```text
CloudConnectorDefinition   目录项：kind、名称、能力、字段说明
CloudConnectorRegistry     内置 + 第三方 provider 注册表
CloudConnector             list / stat / pull 的运行时接口
WhaleConnectorServiceV1   实例状态、浏览、拉取、注册；通过 ctx.provide 暴露
```

内置 kind：

| kind | 服务 | 认证 | 能力 |
| --- | --- | --- | --- |
| `gdrive` | Google Drive REST v3 | access token 或 refresh token 三件套 | 列表、搜索、读取、Google 文档导出 |
| `onedrive` | Microsoft Graph v1.0 | access token 或 refresh token 三件套 | 列表、搜索、读取 |
| `dropbox` | Dropbox HTTP API v2 | access token 或 refresh token 三件套 | 列表、搜索、读取 |
| `webdav` | WebDAV / Nextcloud / ownCloud | Basic（用户名 + 应用密码） | 列表、读取 |

所有 provider 只实现读取。`upload` 在目录里显式为 `false`，避免“先有上传能力再补
审批”造成既成事实。后续若加上传，必须走人类批准和独立 scope。

## 凭据

配置字段只接受**环境变量名**：

```yaml
fleetConnectors:
  connectors:
    - id: team-drive
      kind: gdrive
      refreshTokenEnv: GOOGLE_DRIVE_REFRESH_TOKEN
      clientIdEnv: GOOGLE_DRIVE_CLIENT_ID
      clientSecretEnv: GOOGLE_DRIVE_CLIENT_SECRET
    - id: nextcloud
      kind: webdav
      baseUrl: https://cloud.example.com/remote.php/dav/files/me
      usernameEnv: NEXTCLOUD_USER
      passwordEnv: NEXTCLOUD_APP_PASSWORD
```

- 值不写进 YAML、清单、日志、错误消息或 MCP 返回；
- 静态 access token 缺失时实例在启动阶段标记 `invalid`，不会静默变成“未配置”；
- refresh token 三件套在首次请求时换取 access token，按 `expires_in` 缓存并在过期前
  60 秒刷新；并发请求共享同一次刷新；
- Google 刷新地址 `https://oauth2.googleapis.com/token`，Microsoft 使用
  `https://login.microsoftonline.com/common/oauth2/v2.0/token` 与
  `https://graph.microsoft.com/.default offline_access`，Dropbox 使用
  `https://api.dropboxapi.com/oauth2/token`。

获取 refresh token 的交互式登录不在插件内实现；推荐由运维用一次性 OAuth 工具取得后
写入宿主环境变量，避免把浏览器回调塞进长期运行的 DSH 进程。

## 读取与落盘

- 远程路径只接受相对路径；拒绝 `..`、`.`、控制字符和反斜杠；
- 服务地址必须是 HTTPS；只有本机回环允许 HTTP，便于自托管和测试；
- 单次拉取默认上限 64 MiB，硬上限 512 MiB，可按实例/请求收紧；
- 文件写入 `fleetConnectors.directory`（默认 `fleet/imports`）：
  目录 0700，临时文件与最终文件 0600，先写临时文件再原子重命名；
- 文件名只取 basename，过滤路径分隔符与控制字符；重名自动追加序号；
- 返回 `{localPath, bytes, sha256, pulledAt}`，可直接作为执行材料或回执附件。

## 接入面

### MCP 只读工具

- `whale_connectors`：目录与实例状态，不含凭据；
- `whale_cloud_list`：`id` + 可选 `path` / `query` / `limit`；
- `whale_cloud_pull`：`id` + `path`，需要 `request` scope；只写私有 imports 目录。

### HTTP

- `GET /plugins/dsh-fusion/fleet/connectors`
- `GET /plugins/dsh-fusion/fleet/connectors/list?id=&path=&query=&limit=`
- `POST /plugins/dsh-fusion/fleet/connectors/pull`

HTTP 只接受同源浏览器写请求与 JSON；其余请求沿用宿主认证。

### 第三方注册

```ts
const connectors = ctx.get("whaleConnectors");
const unregister = connectors.register({
  kind: "acme/s3",
  displayName: "Acme S3",
  category: "storage",
  description: "S3-compatible object storage",
  capabilities: { list: true, stat: true, pull: true, upload: false },
  fields: [{ key: "tokenEnv", label: "Token env", env: true, secret: true }],
}, (context) => ({
  async list(input) { /* context.config, context.env, context.fetch */ return []; },
  async pull(input, sink) { /* sink.write(...) */ return { name: "file.bin" }; },
}));
```

第三方 kind 必须带命名空间（如 `acme/s3`），不能覆盖内置 kind；重复注册需要显式
`replace`。注销函数在插件卸载时调用即可。

## 与 DS-Bot 的差异

| 维度 | DS-Bot 连接器 | 鲸群云盘连接器 |
| --- | --- | --- |
| 主要目标 | 把远程 MCP 服务接到 Bot | 把云盘材料接到多机执行 |
| 传输 | MCP 网关 + OAuth | 原生 REST/WebDAV |
| 写入 | 取决于上游 MCP | 本版全部只读 |
| 凭据 | Bot 密钥库 | 宿主环境变量名 |
| 扩展 | 自定义 MCP 条目 | provider 注册表 + 稳定接口 |

鲸群不复制 DS-Bot 的 OAuth 网关、MCP 只读过滤和每 Bot 开关；这些属于会话侧能力。
鲸群只解决“材料从哪来、是否完整、落在哪台机”的问题。

## 验证

- `cloud-connectors.test.ts`：注册表保留名/命名空间/重复注册；Google Drive 列表、
  查询、导出、refresh 缓存；OneDrive 列表/搜索/下载；WebDAV PROPFIND 解析、Basic
  认证、路径穿越拒绝；Dropbox 列表/下载头；importer 的 0600、sha256、大小上限、
  文件名清理、重名与禁用实例。
- `fleet-connector-routes.test.ts`：目录/实例/浏览、同源校验、错误码映射。
- `fleet-mcp.test.ts`：工具清单、浏览调用、`request` scope 拒绝与放行。
- `NativeCloudConnectors.test.tsx`：浏览、拉取和回执展示。

未验证：真实 Google/Microsoft/Dropbox 账号与网络；当前用注入 fetch 的协议级测试。
凭据获取、企业代理和超大文件续传仍属后续工作。

## 后续

1. 上传/导出：人类批准 + 独立 scope + 远端摘要校验；
2. S3/MinIO、Box、Quark 等 provider；
3. 把拉取结果自动绑定为执行材料，并在 v3 回执里记录材料 sha256；
4. 连接器健康检查与最近错误缓存；
5. 令牌轮换与只读窗口。
