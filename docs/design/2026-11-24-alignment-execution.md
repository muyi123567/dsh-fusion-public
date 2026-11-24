# 环境对齐执行

日期：2026-11-24。代码：`packages/plugin/src/fleet-alignment.ts`、
`fleet-alignment-routes.ts`，面板
`packages/client/src/features/native-panel/NativeAlignment.tsx`。

## 目标

`whale_environment_plan` 已经能说明“哪里不一致”，但用户还需要一个安全动作把本机
拉回期望环境。v1 只自动执行三类低歧义动作：

- `enable`：启用已安装但未选中的 bundle；
- `install`：安装期望清单里锁定版本/来源的 bundle；
- `update`：把 bundle 更新到期望的精确版本。

其余动作（patch 恢复、git checkout、clean、credential、upgrade-host、review）
一律保持 `manual`，不生成任意 shell 命令。

## 计划

`whale_alignment_plan` / `POST /fleet/alignment/plan`：

1. 只允许本机 hostId；
2. 复用 `fleet.plan` 的步骤；
3. 通过 `pluginManager.listBundles()` 判断本机是否具备执行条件；
4. 为每步标记 `exec: "auto" | "manual"` 和 `manualReason`；
5. 生成 `planDigest = sha256(canonical(hostId, expected/observed digest, steps))`。

安装规格：

- 期望 bundle 有 `file:` / `link:` / `https://` / `git+` / `github:` 来源时用来源；
- 否则要求精确版本，使用 `name@version`；
- 没有精确版本或来源时为 manual，避免安装 latest。

`installBundle` 调用会带：

```ts
{
  enabled: true,
  saveExact: true,
  expected: { name, version }
}
```

## 请求与批准

状态机：

```text
pending -> running -> succeeded | partial | failed | manual-required
pending -> cancelled
```

- `whale_request_alignment` / `POST /request` 只创建 pending；
- 面板“环境对齐”或 `POST /approve` 由人类批准；
- 运维也可签发带 `approve` scope 的 MCP 令牌调用
  `whale_approve_alignment`；内部 Bot 令牌没有 approve scope；
- 批准时重新生成计划，`planDigest` 不一致立即
  `alignment/plan-changed`，不执行旧计划；
- 请求文件 0600，最多保留 50 条。

## 执行与回滚

批准后：

1. 记录执行前 manifest 和 bundle 快照；
2. 顺序执行 auto 步骤；manual 步骤记录后继续；
3. 任一步失败立即停止；
4. 对已执行步骤逆序回滚：
   - `enable`：原为 disabled 则重新 disable；
   - `install`：新安装的 bundle 重新 disable（不自动卸载）；
   - `update`：重装旧精确版本并恢复原 enabled 状态；
5. `fleet.refresh()` 强制重新采集；
6. 重新 diff，记录 `afterDigest` 与 `after.overall`。

最终状态：

| 条件 | 状态 |
| --- | --- |
| 有步骤失败 | `failed` |
| 有未执行的 manual 步骤 | `manual-required` |
| 全部 auto 成功且 after=match | `succeeded` |
| 全部 auto 成功但仍有漂移 | `partial` |

## 修复的边界情况

启用状态本身会影响 bundle digest。若期望与观测只有 `enabled` 不同，
`bundle.digest` 不再额外生成 `review` 步骤，否则会出现“已经启用但计划仍要求人工审核”
的假失败。

## 接入面

- `GET /plugins/dsh-fusion/fleet/alignment`（可选 `?id=`）；
- `POST .../alignment/plan|request|approve|cancel`；
- MCP：`whale_alignment`、`whale_alignment_plan`、
  `whale_request_alignment`、`whale_approve_alignment`；
- 面板“环境对齐”：生成计划、请求执行、批准/取消、查看结果；
- `ctx.get("whaleAlignment")` 供其他插件读取请求。

## 安全边界

- 只允许本机对齐；远端执行留给后续传输层；
- 不执行任意命令，不自动 clean/checkout/改凭据；
- 计划变化必须重新批准；
- approve 与 request scope 分离；
- 回滚 best effort，失败会记录在 `rollback`；
- 安装/更新依赖宿主 `pluginManager`，网络和包管理器错误原样以短消息记录。

## 验证

- `fleet-alignment.test.ts`：auto/manual 分类、持久化、enable/install、plan-changed、
  失败回滚、manual-required、cancel、远端拒绝。
- `fleet-alignment-routes.test.ts`：列表、计划、请求、批准、取消、同源与错误码。
- `fleet-mcp.test.ts`：request/approve scope 分离。
- `NativeAlignment.test.tsx`：生成计划、请求执行、待批准列表。

实机（`0.2.3-alpha.2` 隔离 profile）：

- 安装无害 fixture bundle 后从 bundles 列表移除，使其 `enabled=false`；
- 期望清单为 `enabled=true`，计划只生成 `enable:dsh-align-fixture`；
- 先验证计划变化会被 `whale/alignment/plan-changed` 拒绝；
- 重新生成请求并由 `approve` scope 令牌批准；
- 执行后 fixture `enabled=true`，重新采集 `after=match`，
  `afterDigest` 与期望完全一致，状态 `succeeded`。

## 后续

1. 远端主机对齐需要签名任务包与执行代理；
2. 安装/更新需要更多真实包源验证；
3. 恢复 patch/checkout 可在受控文件 API 上逐步开放；
4. 运行中请求取消（当前只能取消 pending）。
