# 统一状态与诊断

日期：2026-11-24。代码：`packages/plugin/src/fleet-status.ts`，
`fleet-status-routes.ts`，诊断扩展在 `fleet-doctor.ts`。

## 问题

插件能力增加后，新 Bot 往往要连续调用
`list_hosts → diff → trust → connectors → notifications → backups → alignment`
才知道下一步。既慢，又容易漏掉未信任主机或失败的通知。

## `whale_status`

一次返回：

- 本机 hostId、摘要、overall、stale、签名、验签/信任状态；
- 主机总数、drift、unknown、stale、未信任数量；
- 待审批派发与待批准对齐；
- 云盘 provider/实例（configured/invalid）；
- 通知适配器与最近 50 条回执中的 failed/unknown；
- 已安装 Skill 预设数；
- 最近配置快照时间；
- 信任条目与异常数量；
- 对齐请求 pending/manual/failed；
- 由上述事实推导的 `nextActions`。

约束：

- 只读、不触发网络请求、不读取凭据值；
- 不返回公钥 PEM、URL、令牌或消息正文；
- `nextActions` 是建议，不是自动动作；
- 不把 stale/untrusted 当作匹配。

## 诊断扩展

`whale_doctor` 新增可选子系统检查：

| 检查 | ok | warn |
| --- | --- | --- |
| `connectors.instances` | 至少一个实例就绪 | 无实例或存在 invalid |
| `notifications.adapters` | 有适配器且最近无失败 | 无适配器、invalid、failed 或 unknown |
| `presets.skills` | 已安装 Skill | 未安装 |
| `backup.snapshots` | 有快照 | 没有快照 |
| `trust.hosts` | 有信任条目且无异常 | 无条目、untrusted、invalid/key-mismatch |
| `alignment.requests` | 无待处理 | pending、manual、failed |
| `dispatch.pending` | 无待审批 | 存在待审批 |

没有配置对应服务时不生成检查，避免旧部署被无关警告淹没。

## MCP 指引

`initialize.instructions` 改成推荐的调用顺序：

```text
whale_status
→ whale_list_hosts
→ whale_environment_diff
→ 按需 trust / cloud / notifications / presets / backups / alignment
→ request_* 创建 pending
→ 人工或 approve scope 批准
→ receipt
```

同时明确：不要在没有回执时声称批准或成功。

## 接入面

- MCP：`whale_status`；
- HTTP：`GET /plugins/dsh-fusion/fleet/status`；
- `ctx.get("whaleStatus")`；
- 诊断：`whale_doctor` 与面板“诊断”。

## 验证

- `fleet-status.test.ts`：全部计数、nextActions、无公钥泄漏。
- `fleet-doctor.test.ts`：子系统健康/异常检查。
- `fleet-mcp.test.ts`：工具清单、initialize 指引、单次调用。

## 边界

- 状态是采样快照，不替代逐项 diff/回执；
- 不在状态调用中验证快照内容或发送通知；
- 主机在线状态仍以 manifest 时间与 stale 预算为准。
