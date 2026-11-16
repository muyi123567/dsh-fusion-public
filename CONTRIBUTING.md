# 贡献指南

欢迎提交可复现的问题、文档修正和范围明确的改动。安全问题请先阅读 [SECURITY.md](SECURITY.md)；普通缺陷和功能建议可通过仓库 issue 或 PR 讨论。

## 开始前

阅读 [仓库约定](AGENTS.md)、[项目目的](docs/project/charter.md) 和 [项目状态](docs/project/status.md)，确认改动对应的实际问题、上游能力和未完成范围。本文不要求访问维护者的私人机器、账号或密钥。

DSH Fusion 是 DSH 的原生插件。Room、AgentTeams、AgentBus 以及 DSH 原生 Goal/Session/任务板仍拥有各自的状态与执行语义。请复用它们公开的 API/tool，不创建第二套权威状态，也不要直接修改它们的账本或状态文件。

## 改动原则

- 保持 PR 小且目的明确；共享工作区先约定文件写集，保留其他人的未提交改动，不重置、清理或覆盖别人的工作。
- 行为修复应有能暴露原问题的回归测试；纯文字和低影响修改采用与风险相称的检查。
- 认证、同源检查、命令 allowlist 和输入边界集中在 `packages/plugin/src/auth.ts`；修改权限决策要说明信任假设。
- 遵循 TypeScript 严格配置；可选字段只在有值时加入，避免用 `undefined` 冒充缺席字段。
- UI、接口和文档都应区分未配置、离线、不可验证与合法空数据；不要把失败吞成“已连接、零任务”。
- 上游 revision、owner 和 writeScopes 可以投影展示；writeScopes 不能被当作锁，持久 active 不能被解释为重启后授权自动续跑。
- 不在源码、fixture、日志、截图或 PR 中提交真实凭据和私人基础设施信息。保留正常用户/仓库归属及第三方署名。

## 环境与验证

贡献者可使用自己有权访问的隔离开发环境或 CI 运行构建和测试，无需访问维护者的机器、账号或凭据。请选择能控制测试副作用的环境，并记录相关工具和操作系统版本。本轮维护任务由维护者限定在指定 Instabox 上测试；这只是本轮执行边界，不是社区贡献要求。本次维护不自动新增 CI 流程。

工具版本以仓库 `packageManager`、lockfile 和插件 `engines` 为准。当前 Node 下限为 24.9.0；安装应使用冻结的 lockfile。以下命令可在贡献者自己授权的隔离环境或 CI 执行：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --filter dsh-fusion build
node scripts/doctor.mjs
pnpm --filter dsh-fusion test:package
pnpm test:e2e
pnpm audit --prod --json
pnpm audit --json
```

按改动选择最小有效验证，完整发布由维护者统一运行上述相关门禁。依赖安装和脚本执行前先审查代码。安装、重启或改变真实 profile、远端配置及运行任务，只能在获得相应授权后进行；不要用覆盖现有测试树的方式验证自己的切片。

记录精确提交和补丁摘要、关键文件或产物 SHA-256、工具版本、命令、真实退出码、passed/skipped 数量与环境范围。远程控制包装器成功不代表远端命令成功；需要远端命令自身的退出码。旧提交、旧 tarball 和历史门禁不得作为新改动的通过证据。

产物 doctor 与真实运行 doctor 分开记录；setup 成功、监听端口存在、HTTP 200、单元测试通过分别只证明各自的范围。涉及原生任务板、取消、崩溃恢复或升级回滚的改动，应补相应真实链路证据；没有执行的明确写“未验证”。

## 提交 PR

说明具体触发条件、修改后的行为、验证结果及尚未覆盖的场景。候选能力和后续规划不要写成已交付；由不同于实现者的 reviewer 检查关键改动，证据应与提交版本对应。不要擅自提交共享工作树中的其他改动。

新依赖、复制源码和 vendor 包需注明来源、精确版本、变更与哈希，并保留原始版权及许可证。项目 MIT 许可不替代第三方许可；缺少上游授权文本或 bundled notices 时，先解决再分发。不要自行给来源不明代码补写版权归属。

推送、版本、tag、公开发布及共享 Git 历史处置由维护者统一完成；贡献 PR 不应改变生产部署或凭据。
