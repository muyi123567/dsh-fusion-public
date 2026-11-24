# 远端主机信任表

日期：2026-11-24。代码：`packages/plugin/src/fleet-trust.ts`、`fleet-trust-routes.ts`，
面板 `packages/client/src/features/native-panel/NativeHostTrust.tsx`。

## 问题

多机环境一致性不能只看“缓存里有一份清单”。如果 A 无法验证 B 的签名，
`hosts/*.json` 只是普通 JSON，任何能写目录的人都可以伪造环境摘要并让门禁通过。

## 结论

鲸群把远端清单改成**默认不信任**：

- 远端 hostId 必须绑定一份显式信任的 Ed25519 公钥；
- 没有信任条目、签名无效、公钥与 hostId 不匹配，一律返回 `unknown`；
- 未信任的远端清单不能保存为期望环境；
- 只有本机采集的清单沿用本地验签路径。

## hostId 与密钥

`hostId = sha256(SPKI DER)`，因此：

- hostId 本身就是公钥指纹；
- 密钥轮换会产生新的 hostId，旧信任条目不会自动迁移；
- 同一 hostId 绑定不同公钥是不可能且被拒绝的；
- 旧主机下线后应显式撤销旧条目。

## 公钥从哪来

清单本身不携带公钥：如果公钥放在清单里又不参与签名，攻击者可以同时替换公钥和签名；
如果放进签名载荷，又会改变 v1 摘要契约。因此公钥走带外：

1. 操作员把 B 的 `host-public.pem` 放到
   `fleet/hosts/<hostId>.pub.pem`（也接受 `<hash>.pub.pem` / `.public.pem`）；
2. 面板“主机信任”显示“信任”按钮；
3. 或使用 `scripts/fleet-trust.mjs --host <hostId> --public-key <path>`；
4. 或 `POST /plugins/dsh-fusion/fleet/trust`，body
   `{ "hostId": "...", "publicKeyPem": "..." }`。

## 模式

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `manual`（默认） | 只有显式信任的 hostId 才能通过 | 生产、跨网络 |
| `tofu` | 首次看到带 sidecar 公钥且验签通过的清单时自动固定 | 受控内网、临时集群 |

即使 `tofu` 也必须先验签成功才固定；验签失败不会写入信任表。

## 失败语义

| 状态 | 含义 | 漂移结果 |
| --- | --- | --- |
| `verified` | 信任表公钥验签通过 | 正常比较 |
| `untrusted` | 没有信任条目 | `unknown`，原因“远端清单未受信任” |
| `invalid` | 摘要或签名不匹配 | `unknown`，原因“远端清单签名无效” |
| `key-mismatch` | 公钥与 hostId 不一致 | `unknown`，原因“远端公钥与 hostId 不匹配” |
| `unknown` | 本机没有验签器 | 仅本机旧路径，远端生产不会出现 |

`listHosts` 同时返回 `signed`（是否有 Ed25519 签名）与 `verified`/`trust`
（是否真的验签通过），UI 不应把 `signed=true` 当成已验证。

## 存储

`trusted-hosts.json`：

```json
{
  "version": 1,
  "hosts": [
    {
      "hostId": "sha256:...",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
      "fingerprint": "sha256:...",
      "source": "manual",
      "addedAt": "2026-11-24T00:00:00.000Z",
      "updatedAt": "2026-11-24T00:00:00.000Z"
    }
  ]
}
```

- 目录 0700、文件 0600、原子重命名；
- 只存公钥，不存私钥；
- 损坏或字段不完整的条目在加载时忽略，不会导致整个插件启动失败。

## 接入面

- `GET /plugins/dsh-fusion/fleet/trust`：模式、条目、每台主机状态；
- `POST /plugins/dsh-fusion/fleet/trust`：显式信任（可带 `publicKeyPem`）；
- `POST /plugins/dsh-fusion/fleet/trust/revoke`：撤销；
- `whale_host_trust`：只读 MCP 工具；
- 面板“主机信任”：有 sidecar 公钥时一键信任，已信任可撤销；
- `scripts/fleet-trust.mjs --list/--revoke/--host`：运维命令行。

## 安全边界

- 不信任 `hosts/*.json` 中的 `signature.keyId`，它只是标签，不是公钥；
- 不自动把新公钥当成旧主机的新密钥；
- 不在日志或 API 返回私钥；
- `tofu` 不是默认值，生产应使用 `manual`；
- 信任表只解决“清单确实由该 hostId 的私钥签署”，不解决主机被完全接管后的行为。

## 验证

- `fleet-trust.test.ts`：真实 Ed25519 生成、hostId 绑定、持久化 0600、损坏文件、
  `manual` 不自动固定、`tofu` 先验签后固定、篡改清单、撤销、无私钥泄漏。
- `fleet-service-trust.test.ts`：未信任阻断、显式信任后匹配、保存期望拒绝未信任、
  篡改清单 unknown、sidecar TOFU、密钥不匹配、撤销回退。
- `fleet-trust-routes.test.ts`：列表、信任、撤销、同源与错误码。
- `fleet-mcp.test.ts`：`whale_host_trust` 工具。
- `NativeHostTrust.test.tsx`：信任与撤销交互。

未验证：真实两台 Instabox 主机的公钥分发链路；本次用本地真实密钥与缓存清单模拟。
