# 开放通知适配器

日期：2026-11-23。代码：`packages/plugin/src/fleet-notification-adapters.ts`、
`fleet-notification-routes.ts`，面板
`packages/client/src/features/native-panel/NativeNotificationAdapters.tsx`。

## 目标

派发审批、执行失败和环境漂移必须能到达用户真正待的地方。DS-Bot 的连接器目录证明了
“平台很多、每个平台细节不同”这件事不该散落在主流程里，因此鲸群把通知做成独立适配器：

1. 内置常用渠道，开箱即用；
2. 凭据只写环境变量名；
3. 失败隔离、超时、回执与测试入口；
4. 第三方插件可注册自己的适配器。

## 内置适配器

| kind | 传输 | 回执 | 说明 |
| --- | --- | --- | --- |
| `dsh-im` | 宿主 `dshIm.sendChecked` / `send` | 是（`sendChecked`） | 复用 dsh-im 已接入的 Slack、Telegram、Discord、飞书、钉钉、QQ、企微、微信、邮件、Matrix 等渠道 |
| `webhook` | HTTP POST JSON | HTTP 2xx | 带 `X-DSH-Fusion-Signature: sha256=<HMAC>` |
| `slack` | Incoming Webhook | HTTP 2xx | `{text}` |
| `feishu` | 自定义机器人 | HTTP 2xx | `{msg_type:"text",content:{text}}` |
| `dingtalk` | 自定义机器人 | HTTP 2xx | `{msgtype:"text",text:{content}}`，可选加签 |
| `telegram` | Bot API `sendMessage` | HTTP 2xx | `tokenEnv` + `chatId` |
| `discord` | Incoming Webhook | HTTP 2xx | `{content}` |

HTTP 适配器只接受 HTTPS；本机回环允许 HTTP。URL 长度、超时和文本长度都有上限，
错误只保留状态码与稳定错误码，不回传响应正文。

## dsh-im 原生回执

dsh-im 的 `sendChecked(..., { receipt: true })` 会返回
`{ sent: true, receipt: { version, messageId, conversationId } }`。
鲸群把这三个字段原样写入自己的回执记录，用于后续关联话题回复。

如果 dsh-im 抛出 `send-result-unknown`，鲸群记录 `status: "unknown"` 并**不自动重试**：
平台可能已经接受消息，重复发送会造成重复通知。

`sendChecked` 不存在时退回 `send`；两者都没有时该实例在发送阶段失败为
`notification/unavailable`，不影响其他适配器。

## 配置

```yaml
fleetNotifications:
  directory: /var/lib/dsh-fusion/fleet/notification-receipts.json
  adapters:
    - id: ops-slack
      kind: slack
      urlEnv: FUSION_SLACK_WEBHOOK
    - id: team-feishu
      kind: feishu
      urlEnv: FUSION_FEISHU_WEBHOOK
      events: [created, approved, failed]
    - id: oncall-telegram
      kind: telegram
      tokenEnv: FUSION_TELEGRAM_BOT_TOKEN
      chatId: "-1001234567890"
      timeoutMs: 5000
    - id: chief-im
      kind: dsh-im
      botId: chief
      targetId: group-ops
      format: markdown
```

旧的 `fleetNotifications.dshIm` 与 `fleetNotifications.webhook` 仍可用，会被转换成
`legacy-dsh-im` / `legacy-webhook`，不需要迁移。

## 事件与回执

事件类型：`created`、`approved`、`rejected`、`failed`、`test`。

回执字段：

```json
{
  "adapterId": "ops-slack",
  "kind": "slack",
  "eventType": "created",
  "status": "delivered",
  "at": "2026-11-23T12:00:00.000Z",
  "durationMs": 42,
  "httpStatus": 204
}
```

- `status`：`delivered` / `failed` / `unknown` / `skipped`；
- `skipped` 用于停用或事件过滤；
- 回执只保存元数据，不保存消息正文、URL、令牌或平台响应；
- 最多保留 100 条，原子写入 0600 文件。

## 接入面

- `whale_notifications`：目录、实例状态、最近回执；
- `whale_notify_test`：需要 `request` scope，发一条 `test` 事件；
- `GET /plugins/dsh-fusion/fleet/notifications`；
- `POST /plugins/dsh-fusion/fleet/notifications/test`；
- 面板“通知适配器”：查看最近状态、逐项测试；
- 第三方注册：

```ts
ctx.get("whaleNotifications").register({
  kind: "acme/push",
  displayName: "Acme Push",
  category: "im",
  description: "Acme push gateway",
  receipt: false,
  fields: [{ key: "urlEnv", label: "URL env", env: true, secret: true }],
}, (context) => ({
  async deliver(event, text) {
    // context.config / context.env / context.fetch
    return { status: "delivered", httpStatus: 204 };
  },
}));
```

第三方 kind 必须带命名空间，不能覆盖内置 kind。

## 安全边界

- 不在配置、日志、回执或 MCP 返回中出现令牌；
- 凭据字段只写环境变量名；
- 不回传平台响应正文；
- 不自动重试 `unknown`；
- 不执行任意 shell 命令；
- 单适配器失败不影响其他适配器，也不回滚已批准派发。

## 验证

- `fleet-notification-adapters.test.ts`：7 个内置 kind、第三方命名空间、六种 HTTP
  载荷、钉钉加签、dsh-im `sendChecked` 回执、`send-result-unknown` 不重试、
  事件过滤、失败隔离、回执持久化、缺失凭据/非法 URL。
- `fleet-notification-routes.test.ts`：列表、测试、同源校验与错误码。
- `fleet-mcp.test.ts`：工具清单、`request` scope 拒绝与放行。
- `NativeNotificationAdapters.test.tsx`：最近回执与逐项测试。

未验证：真实 Slack/飞书/钉钉/Telegram/Discord 账号，以及真实 dsh-im 渠道发送；
当前用本地 HTTP 接收器和注入的 dsh-im 发送器做契约验证。

## 后续

1. 入站命令（如“批准 request-1”）需要独立签名与白名单，不与出站适配器混在一起；
2. 通知重试策略与死信队列；
3. 按事件类型路由到不同渠道的规则引擎；
4. dsh-im 目标列表自动发现与配置向导。
