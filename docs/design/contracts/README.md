# Fleet contracts v1

这十份 Schema 是鲸群对外开放的机器可读契约：

- `fleet-manifest.v1.schema.json`：单台主机的公开环境事实。
- `drift-report.v1.schema.json`：期望环境与观测环境的确定性比较。
- `task-envelope.v1.schema.json`：一次跨机派发意图。
- `cloud-connector.v1.schema.json`：云盘 provider 目录、实例状态、文件条目与拉取回执。
- `notification-adapter.v1.schema.json`：通知适配器目录、实例状态与投递回执。
- `trusted-host.v1.schema.json`：远端主机公钥信任表。
- `preset-backup.v1.schema.json`：预设目录与配置快照清单。
- `alignment-request.v1.schema.json`：本机环境对齐请求、步骤与执行结果。
- `fleet-status.v1.schema.json`：一次调用的多机与子系统状态摘要。
- `host-bundle.v1.schema.json`：主机加入包（清单、公钥、摘要）。

## 版本规则

- `contractVersion` 是整数，不是软件版本。
- v1 内只允许加法：新增可选字段、枚举值或错误码；不得删除字段、改变语义或收紧必填。
- 消费方必须忽略未知字段；遇到未知 `contractVersion` 必须拒绝，不得猜测兼容。
- 破坏性变更必须新建 `*.v2.schema.json`，并保留 v1 至少两个 minor 版本。

## 规范化与摘要

`environmentDigest` 的计算输入：

1. 取 `FleetHostManifest` 对象；
2. 删除 `hostId`、`displayName`、`staleAfterSeconds`、`secrets`、`observedAt`、
   `environmentDigest`、`secretPresenceDigest`、`signature`；
3. 递归排序对象键（JS 默认字符串排序），数组保持原顺序；
4. `JSON.stringify` 且不加空白，UTF-8 编码；
5. 计算 `sha256(utf8(JSON.stringify(["dsh-fleet-environment/v1", canonical])))`；
6. 输出 `sha256:<64 位小写十六进制>`。

`secretPresenceDigest` 单独计算：

```text
sha256(utf8(JSON.stringify([
  "dsh-fleet-secret-presence/v1",
  sortedSecrets.present,
  sortedProviders
])))
```

它只覆盖密钥名称的存在性与 provider 名称，绝不覆盖值。`environmentDigest` 不包含 L3。
`mcpServers[].transport` 在宿主不暴露传输类型时为 `unknown`，采集器不猜测。

## 签名

- 算法：Ed25519。
- `keyId` 由主机公钥派生并固定；`hostId` 与 `keyId` 的绑定由信任表维护。
- 签名输入：`utf8(JSON.stringify(["dsh-fleet-manifest-signature/v1", manifestWithoutSignature]))`。
- `signature.value` 为标准带 padding base64（Ed25519 为 88 字符）。
- 验证方必须同时校验：签名、`hostId` 与公钥绑定、`environmentDigest` 可重算、
  `observedAt` 未超过策略允许的过期时间。

## 绝不进入清单的内容

- 私钥、令牌、API key、OAuth grant、cookie。
- 完整命令、脚本正文、会话正文、任务正文。
- 用户主目录明文路径；只允许 `rootHash` 或调用方明确要求的受控路径。
- 端口、pid、内存、CPU 等易变运行指标（能力枚举除外）。

## 消费示例

```ts
if (manifest.contractVersion !== 1) throw new Error("unsupported fleet manifest")
const report = await whaleFleet.diff(manifest.hostId, expectedDigest)
if (report.overall === "unknown") return // 不可当作 match
if (report.items.some(item => item.severity === "block")) return // 门禁拒绝
```

Schema 的 `additionalProperties: false` 用于本仓库生成与测试；外部消费方按上面的版本规则
忽略未知字段即可。
