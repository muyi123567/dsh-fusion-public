# DSH Fusion

DSH 原生多机操作插件：在一个工作区管理 SSH/容器和 Instabox Host、任务派发与证据、
会话、Room / AgentTeams / AgentBus 桥接、配置检查和可选终端。

当前公开版本：**0.2.0-beta.12**，MIT。

## 安装

从本仓库 Releases 下载预构建包与 SHA256SUMS，校验后安装到 Web profile：

~~~sh
dsh plugin --profile web add ./dsh-fusion-0.2.0-beta.12.tgz
~~~

重载 profile 后打开侧栏 Fusion。包已包含 host、客户端与类型声明；
运行依赖仍需要网络或已有缓存。companion 安装、配置、升级与回滚见
[插件说明](packages/plugin/README.md)。

| 运行要求 | 版本 |
| --- | --- |
| Node.js | >=24.9.0 |
| DSH 安装范围 | >=0.2.0-rc.2 <0.3.0 |
| 推荐宿主 | 0.2.2-rc.1 |
| 候选宿主 | 0.2.2-rc.3，范围与证据见发布说明 |
| AgentTeams companion | 0.1.30 |
| Room / AgentBus | 0.7.0 / 0.1.1（兼容补丁版） |

安装范围不等于所有组合均已通过业务验收。

## 本版变化

- 每 Host 的资源所有者、共享模式和并发配额，启动中的任务也占用名额。
- 只读投影原生 AgentTeam 的 revision、负责人、依赖、ready 和写入范围。
- 幂等恢复、取消与状态刷新的竞态修复，旧账本和聚合子任务的证据重新校验。
- 完成回执绑定任务/节点，拒绝错配、重复字段、旧证据和兄弟任务证据补位。
- AgentTeams 0.1.30 兼容升级，测试链修复已知依赖公告。
- 预构建包附带第三方许可与来源声明。

## 验收边界

模型写入和远程终端默认关闭，凭据仅在宿主解析。
Host owner 声明不能替代系统账号隔离或成员级 ACL；writeScopes 只是提示。
跨 Host fencing 租约、独立 reviewer 绑定代码版本和候选补丁自改进仍未交付。
真实模型任务、完整多 Session 协作、第三台节点和升级恢复矩阵仍待独立验收。

最新结果与包哈希见 [发布说明](docs/releases/2026-11-16-beta12.md)。
[公开来源](PUBLICATION.md)解释本仓库如何排除私人运维历史。

## 开发

~~~sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter dsh-fusion build
node scripts/doctor.mjs
pnpm --filter dsh-fusion test:package
pnpm test:e2e
pnpm audit --json
~~~

使用已授权的隔离环境验证。
[扩展文档](docs/extensions/task-views.md) · [贡献指南](CONTRIBUTING.md) ·
[安全政策](SECURITY.md) · [项目状态](docs/project/status.md)。
