# DS-Bot Chief · M2 实机验收 Runbook

目标：在隔离 DSH profile 中同时加载 DS-Bot 与鲸，确认 Chief Bot 能看到并实际调用
`whale_list_hosts`，返回本机环境清单与漂移状态。该验收只证明本机 MCP 与 DS-Bot 工具可见性，
不证明真实双机、派发或生产 profile。

## 前置

- 开发机：`muse-instabox`（Tailscale，Ubuntu）。
- DSH 0.2.2-rc.x，含 `mcpManager`（`ctx.get('mcpManager').register` 可用）。
- DS-Bot 0.3.x 已安装；至少存在一个 Chief/Main Bot。
- 鲸候选包已构建：`packages/plugin/dist` 与 `dist/client.*`。
- 全程使用隔离 profile 名，例如 `m2-open-fleet`；不碰用户 production profile。

## 1. 创建隔离 profile

```sh
dsh --profile m2-open-fleet --from-default-profile web
dsh plugin --profile m2-open-fleet add /absolute/path/dsh-fusion-<version>.tgz
dsh plugin --profile m2-open-fleet add ds-bot
```

确认 profile 只用于本轮：

```sh
dsh --profile m2-open-fleet --dump-config > /tmp/m2-open-fleet.dump.yml
grep -nE 'dsh-fusion|ds-bot|mcp' /tmp/m2-open-fleet.dump.yml
```

## 2. 配置鲸

在隔离 profile 的 `cordis.patch.yml` 中给 `dsh-fusion` 增加：

```yaml
- id: dsh-fusion
  config:
    fleetEnvironment:
      directory: /tmp/dsh-fusion-m2/fleet
      staleAfterSeconds: 900
      displayName: muse-instabox
    fleetMcp:
      enabled: true
      port: 8797
```

不要在该文件写任何 API key、令牌或私钥。首次启动会生成
`/tmp/dsh-fusion-m2/fleet/host-key.pem`（0600）和 `mcp.json`（0600）。

## 3. 启动并验证本机 MCP

```sh
dsh --profile m2-open-fleet web
```

另一个终端：

```sh
umask 077
node packages/plugin/scripts/fleet-mcp-token.mjs --file /tmp/dsh-fusion-m2/fleet/mcp.json --name runbook-check > /tmp/m2-token.txt
printf 'authorization: Bearer %s\n' "$(cat /tmp/m2-token.txt)" > /tmp/m2-header.txt
curl -sS http://127.0.0.1:8797/mcp -X POST \
  -H 'content-type: application/json' \
  -H @/tmp/m2-header.txt \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

预期：只出现四个只读工具；`Origin`、非 loopback Host、错误令牌分别返回 403/403/401。
令牌只放在 0600 文件，不进入命令行；验收后删除令牌文件并 `--revoke` 该客户端。

## 4. 让 Chief 实际调用

在 DS-Bot 的同一 profile 中打开 Chief 会话，发送：

```text
调用 mcp__whale-fleet__whale_list_hosts，只返回主机 ID、环境摘要和漂移状态。
```

预期：

- Chief 的工具列表出现 `mcp__whale-fleet__whale_list_hosts`。
- 工具返回 `hosts` 数组，至少包含本机 `hostId`、`environmentDigest` 与 `overall`。
- Chief 的回复引用的是工具返回，而不是猜测或复述指令。

保存证据：

```sh
date -u +%FT%TZ
curl -sS http://127.0.0.1:<dsh-port>/plugins/dsh-fusion/fleet/hosts
```

以及 Chief 回复截图/文本、profile dump、插件版本、`mcp.json` 客户端列表（不含 token）。

## 5. 失败处理

| 现象 | 检查 |
| --- | --- |
| Chief 没有 whale 工具 | profile 是否加载鲸；`mcpManager` 是否可用；8797 是否被占用；日志是否报 MCP 注册失败 |
| MCP 返回 401 | 令牌文件是否被重写；内部令牌每次激活轮换，外部客户端需重新发放 |
| MCP 返回 403 | 请求是否带 Origin；Host 是否 loopback |
| 工具返回 `whale/host-unknown` | 主机 ID 是否来自 `whale_list_hosts` |
| `environment.overall=unknown` | 未配置期望清单或清单过期；这是正确语义，不是匹配 |

## 6. 边界

- 不修改 production profile，不发送真实业务任务，不调用付费模型做无关测试。
- 不把令牌写入仓库、聊天、日志或截图。
- 本 runbook 通过只证明本机 MCP 与 DS-Bot 工具可见性；真实双机与执行回执仍需单独授权与证据。
