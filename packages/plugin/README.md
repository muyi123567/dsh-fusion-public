# 🐋 鲸 · Whale

鲸是 DSH 原生多机协作插件，包含节点、任务证据、会话、Room/Teams/Bus 桥接、配置诊断和可选远程终端。

## 安装预构建包

当前可安装范围为 DSH `>=0.2.0-rc.2 <0.3.0` 和 Node.js `>=24.9.0`。
`0.2.2-rc.1` 仍是 recommended / verified；`0.2.0-rc.2` 保留为兼容基线；
`0.2.2-rc.3` 是最新 candidate，安装时仍显示 `untested`，直至 Instabox
矩阵完成。beta.12 内置 AgentTeams 0.1.30，保留退役成员安全守卫；
安装检查通过不等于完整运行矩阵通过。将预构建 tarball 安装进已有的 Web profile：

~~~sh
dsh plugin --profile web add ./dsh-fusion-0.2.0-beta.13.tgz
~~~

profile 名称可替换为自己的名字。重启或重新加载对应 profile 后，从侧栏的 Fusion 入口打开。
安装需要解析 package.json 中的运行依赖；单个 tarball 不包含完整离线依赖缓存。

不要把开发仓库源码当作已经构建的发布包。此包已经包含 host、launcher、workspace、terminal 与公开类型声明，使用方不需要重新编译。

安装 Fusion 后，可用内置 setup 命令把同一 release 验证过的 Room、AgentTeams 和
AgentBus companion 安装到当前 profile。安装器会先核对 DSH/Node 版本与
`release.json`，再备份 profile；相同版本和包哈希会幂等跳过，不同版本默认拒绝，
只有显式 `--force-companions` 才替换：

~~~sh
node "$DSH_HOME/profiles/web/node_modules/dsh-fusion/scripts/setup.mjs" \
  --profile web
~~~

setup 会先备份 profile manifest、锁文件、Cordis 覆盖层和 patches，再安装包内
`dsh-agent-team-room@0.7.0`、`@nanmicoder/dsh-agent-teams@0.1.30` 和修补后的
`dsh-agent-bus@0.1.1`。安装失败会恢复备份；`--dry-run` 只输出计划；
`--without-companions` 只保留 Fusion；`--without-room` 仅跳过 Room；
`--force-room` 仅允许替换 Room。安装结束后会核对 profile 依赖、实际安装版本、
生产入口和每个 companion 哈希；可用下面的命令单独复验：

~~~sh
node "$DSH_HOME/profiles/web/node_modules/dsh-fusion/scripts/setup.mjs" \
  --profile web --verify
~~~

`release.json` 与 `compatibility.json` 是包内发布契约，固定 DSH 安装范围、
verified/candidate 矩阵、Node 最低版本和三个 companion 的 SHA-256。任一字段
不一致时 setup 会在写入 profile 前失败。范围外宿主直接拒绝；范围内未实测宿主
写入 receipt 并在 stderr 打印 `DSH_FUSION_DSH_HOST_UNTESTED`。

若使用 setup 作为全新 profile 的入口，必须通过 `--fusion-tgz` 同时提供 Fusion
tarball；也可先执行本文首段的 `dsh plugin ... add`，由 DSH 创建 profile。
安装失败时安装器只删除本次创建的未完成 profile。已有 profile 的失败路径恢复
manifest、锁文件、Cordis 覆盖层和 patches，并尝试恢复依赖。

## 配置与能力

配置通过该 profile 的 Cordis 用户配置层覆盖 dsh-fusion 行，或使用运行环境中的 FUSION_* 配置。
节点连接信息和凭据引用在宿主侧解析；密钥内容不进入浏览器或任务账本。

- 通用 N 节点通过 `sshNodes` 与 `instaboxNodes` 数组配置。每个节点有唯一
  `nodeId`；SSH 节点只接受 key/known_hosts 路径引用，Instabox 节点复用进程中的
  `INSTABOX_API_KEY`，密钥内容不进入 profile、浏览器或任务账本。
- 每个 Host 可以声明 `hostAccess`：`ownerId` 表示资源所有者，`sharingMode`
  为 `dedicated` 或 `shared`，`maxConcurrentTasks` 限制该机器的活动任务数。
  达到上限时 Fusion 拒绝继续派发并返回 `FLEET_NODE_CONCURRENCY_LIMIT`；
  HTTP 任务入口使用 429，避免把单机压爆。共享 Host 必须声明所有者。
- Room、AgentTeams、AgentBus 由单包 setup 安装经过验证的兼容组合，Fusion 通过
  上游支持的接口桥接。
- AgentTeams、AgentBus、Room 的模型写入默认关闭；分别由 FUSION_ALLOW_AGENT_TEAM_WRITES、FUSION_ALLOW_AGENT_BUS_WRITES、FUSION_ALLOW_ROOM_WRITES=true 显式启用。
- 远程终端默认关闭；FUSION_ALLOW_REMOTE_PTY=true 后，每台已配置 SSH 节点使用
  独立的 PTY 服务、终端 id 与 capability token。Instabox 节点目前不开放 PTY。
- 配置 apply 目前管理 Fusion manifest；实际 DSH/runtime 配置激活仍是后续工作。
- Fusion 自有默认与演示 Bot 使用 `ccs-wb/cn:deepseek-v4.1-flash`，推理强度为
  `max`。真实 AgentTeams 成员的模型与推理强度仍以 DSH/上游快照为准。

界面读取真实快照；状态未知或来源不可用会明确显示。侧栏“开箱检查”统一呈现
运行时、节点、配置一致性、可选协作来源与 doctor 结果。工作区与终端按需加载，
关闭或卸载时清理对应样式和组件。

DSH 兼容状态由 doctor 单独呈现：verified 为 `ok`，untested 或 unknown 为
`degraded`，范围外为 `failed`。节点 online、provider connected 与扩展动作授权
不会覆盖宿主兼容结论。

示例：

~~~yaml
- id: dsh-fusion
  config:
    sshNodes:
      - nodeId: gpu-a
        host: gpu-a.example
        keyPath: /run/credentials/dsh-fusion-gpu-a
        knownHostsPath: /etc/dsh-fusion/known_hosts
        name: GPU Worker A
    instaboxNodes:
      - nodeId: box-b
        machineName: dsh-fusion-box-b
        timeoutMs: 60000
        hostAccess:
          ownerId: team-alpha
          sharingMode: shared
          maxConcurrentTasks: 3
~~~

节点 id 必须在 SSH 与 Instabox 两个集合间全局唯一；部分配置、重复 id 或越界
输出上限会在加载阶段 fail closed。

## 升级、移除与验证

升级前备份 profile 的 package.json、锁文件、Cordis 用户配置和 Fusion 自有状态。保留旧 tarball 作为回滚入口。

~~~sh
dsh plugin --profile web remove dsh-fusion
~~~

移除插件不代表删除上游会话、Room、Teams 或 Bus 数据。远端持久 job 的保留和清理应按节点策略处理。

当前 beta.13 的验证范围与包哈希见 [发布说明](../../docs/releases/2026-11-16-beta13.md)。
包内 dist/THIRD_PARTY_NOTICES.txt 与 vendor 许可说明保留第三方来源。

## License

Fusion 使用 MIT，第三方组件遵循各自许可证。
