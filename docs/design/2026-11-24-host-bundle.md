# 主机加入包

日期：2026-11-24。代码：`packages/plugin/src/fleet-host-bundle.ts`、
`fleet-bundle-routes.ts`，CLI `scripts/fleet-join.mjs`。

## 问题

多机环境保护已经有远端信任表，但用户仍需分别复制：

1. 远端 `host-public.pem`；
2. `hosts/<hostId>.json`；
3. 期望清单。

任何一步漏掉，主机就会显示 unknown 或无法参与门禁。加入包把这三件事合成一个可校验
的 JSON。

## 格式

```json
{
  "contractVersion": 1,
  "createdAt": "2026-11-24T07:00:00.000Z",
  "manifest": { "contractVersion": 1, "hostId": "sha256:...", "...": "..." },
  "publicKeyPem": "-----BEGIN PUBLIC KEY-----...",
  "digest": "sha256:..."
}
```

`digest = sha256(canonicalJson({contractVersion, createdAt, manifest, publicKeyPem}))`。
加入包本身不携带私钥，也不携带 `secrets` 值，只保留 `secrets.present` 名称。

## 校验

导入依次检查：

1. 字段完整、contractVersion=1；
2. 加入包 digest 与内容一致；
3. `hostIdFromPublicKey(publicKeyPem) === manifest.hostId`；
4. `verifyFleetManifest(manifest, publicKeyPem)` 通过。

任何一步失败都返回稳定错误码：`bundle/digest-invalid`、`bundle/key-mismatch`、
`bundle/signature-invalid`。

## 导出

```text
whale_host_bundle
GET /plugins/dsh-fusion/fleet/bundle
```

只导出本机清单和本机公钥；如果主机密钥尚未生成，返回 `bundle/key-unavailable`。

## 导入

```text
whale_import_bundle   （approve scope）
POST /plugins/dsh-fusion/fleet/bundle/import
node scripts/fleet-join.mjs --bundle host-b.json --fleet <dir> --trust --expected
```

导入动作：

1. 缓存到 `hosts/<hostId>.json`（0600）；
2. `pinTrust:true` 时写入 `trusted-hosts.json`；
3. `saveExpected:true` 时写入 `expected-manifest.json`；
   如果该文件已存在，先复制为 `expected-manifest.json.bak-<timestamp>`（0600）；
4. 刷新本机 manifest 缓存，让下一次 diff 立即看到远端。

默认两个开关都是 false；面板/运维必须显式选择。

## 安全边界

- 加入包不能携带私钥或环境变量值；
- 导入不会自动执行对齐、安装或 shell；
- 不覆盖已有信任公钥（hostId 绑定公钥，轮换会产生新 hostId）；
- 期望清单覆盖是显式动作，配置热备可提供回滚；
- 跨机传输仍需用户选择 SSH、对象存储或手工复制。

## 验证

- `fleet-host-bundle.test.ts`：真实 Ed25519 导出/导入、摘要/公钥/签名篡改、
  0600 文件、无信任/期望时的最小导入。
- `fleet-bundle-routes.test.ts`：导出、同源导入、trust/expected 标志。
- `fleet-mcp.test.ts`：approve scope 与导出工具。

## 后续

1. 加入包二维码/短链接；
2. 扫描远端 `/.well-known/dsh-fusion.json` 自动拉取；
3. 加入包版本与最低插件版本检查；
4. 与对齐请求合并为“加入并对齐”单动作。
