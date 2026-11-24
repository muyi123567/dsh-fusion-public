# 五分钟快速开始

## 1. 安装

```sh
dsh plugin --profile web add ./dsh-fusion-0.2.0-beta.15.tgz
```

重载 profile，从侧栏「鲸」打开面板。需要 companion 时：

```sh
node packages/plugin/scripts/setup.mjs --profile web --fusion-tgz ./dsh-fusion-0.2.0-beta.15.tgz
node packages/plugin/scripts/setup.mjs --profile web --verify
```

`--verify` 会检查包版本、dist、presets/whale-fleet-ops、fleet-trust/fleet-join 脚本和
composed profile，并输出 next actions。

## 2. 打开 MCP

在 profile patch 中加入：

```yaml
- id: dsh-fusion
  config:
    fleetMcp:
      enabled: true
      port: 8797
```

重载后发放客户端令牌：

```sh
node node_modules/dsh-fusion/scripts/fleet-mcp-token.mjs --name my-agent
```

令牌只输出一次，文件只保存 SHA-256。新客户端先调用 `whale_status`，再按需展开。

## 3. 安装 Skill 与快照

面板“预设与热备”：

1. 安装 `whale-fleet-ops`；
2. 创建第一份配置快照；
3. 开启 `fleetBackup.auto`（可选）。

## 4. 接入另一台主机

在主机 A：

```text
whale_host_bundle
```

把返回 JSON 保存为 `host-a.json`，复制到主机 B，然后在面板“主机加入包”导入，
勾选“固定信任”和“保存期望”。或使用：

```sh
node node_modules/dsh-fusion/scripts/fleet-join.mjs \
  --bundle host-a.json --trust --expected
```

导入后运行：

```text
whale_list_hosts
whale_environment_diff
```

远端应显示 verified；未信任、过期或签名失败的清单不会被当作匹配。

## 5. 云盘与通知（可选）

- 云盘：配置 `fleetConnectors`，先拉取材料；上传需要 operator-only `approve` scope。
- 通知：配置 `fleetNotifications.adapters`，面板可逐项测试。
- 有 dsh-im 时优先使用 `sendChecked` 回执；`send-result-unknown` 不自动重试。

## 6. 自检

```text
whale_status
whale_doctor
```

`warn` 通常表示尚未配置期望清单、连接器、通知、信任或执行作业；`fail` 才表示
MCP/DSH 等核心链路不可用。
