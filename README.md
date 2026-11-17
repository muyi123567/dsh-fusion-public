# 🐋 鲸 · Whale

鲸是 DSH 原生多机协作插件，在宿主右侧面板查看任务、主机、团队与执行证据，
上游会话与 Room / AgentTeams / AgentBus 保留自己的状态与执行语义，鲸不创建第二套权威状态。
本 native 候选默认用于任务 / 主机 / 团队 / 海域查看和证据导航。旧 FusionApp 的派发、配置、
运行与终端组件及 host API 保留在源码中，尚未全部迁入新入口；不承诺与 beta.13 UI 功能完全等价。

当前候选：**0.2.0-beta.14**，MIT，可试验的原生面板预发布。任务默认显示，海域按需打开。
[候选发布说明与验证范围](docs/releases/2026-11-17-beta14.md)。
最近已发布版本为 **0.2.0-beta.13**；[历史发布说明](docs/releases/2026-11-16-beta13.md)
与 [预构建包](https://github.com/muyi123567/dsh-fusion-public/releases/tag/v0.2.0-beta.13)保留。
beta.14 当前发布候选 SHA-256：`3a317257ceb5e4f77b756c9e72a63530e56e73146109ecd5613163385139ee26`，尚未宣称公开发布。
海域分页按钮已调整以避免 companion 浮动控件拦截；同一新包的真实来源 / 公开扩展、修后性能 / 分页、
420px DEMO 任务 / 海域预览三组运行均完成，`QA_EXIT=0`、`DSH_STOPPED=True`。
较早候选的 UI 通过记录单独保留，beta.13 包或独立动画预览不代替本候选验收。

## 原生右栏面板

选择 DSH 会话，从侧栏「鲸」或右栏添加页打开面板：

- 默认任务列表，受阻、失败与待验收优先；可搜索名称或归属、按状态筛选。
- 任务、主机、团队详情在同一面板打开；支持返回与面板内 Escape。
- 宿主管理标签、关闭和宽度，颜色与字体继承 DSH；桌面聊天区保留在旁边。
- 海域由用户主动切换，届时才加载场景与 3D。窄屏右栏可能由宿主自行切换全屏。

当前快照是 Fusion 全局来源，不是当前会话的专属列表。
缺少证据不能解释为成功；SSH 可达不等于终端登录或任务完成。
主机连接、兼容性、能力与权限分别呈现，团队成员依照 `AgentTeam.taskIds` 声明。

[产品说明](docs/design/2026-11-17-native-panel-product.md) ·
[接入规划](docs/design/2026-11-17-whale-native-panel-plan.md) ·
[原生验收方法](docs/design/2026-11-17-native-panel-acceptance.md)

## 安装与升级

从维护者提供的同一 release 下载 tarball 与 `SHA256SUMS`，核对后由 DSH 宿主安装。
beta.13 升级到 beta.14 前备份目标 profile 与 Fusion 自有状态，并保留旧包：

~~~sh
dsh plugin --profile web add ./dsh-fusion-0.2.0-beta.14.tgz
~~~

重载对应 profile，选择会话后打开「鲸」。`web` 可替换成自己的 profile 名称。
查看面板不需要开启模型或发送消息，模型写入与远程终端默认关闭。
本轮只验证隔离候选环境，未改动用户 production profile。
完整升级、companion 安装、校验与回滚说明见 [插件说明](packages/plugin/README.md)。

| 运行要求 | 版本与范围 |
| --- | --- |
| Node.js | >=24.9.0 |
| DSH 安装范围 | >=0.2.0-rc.2 <0.3.0 |
| 本轮推荐宿主 | 0.2.2-rc.3；仅依据本轮启动 / UI 实测范围 |
| 候选宿主 | 0.2.0-rc.2 / 0.2.2-rc.1；API 已核实存在，beta.14 组合未重新实测 |
| AgentTeams companion | 0.1.30 |
| Room / AgentBus | 0.7.0 / 0.1.1（兼容补丁版） |

包内 recommended / tested 仅为 0.2.2-rc.3，verified 仅限本轮启动与原生 UI 范围。
包包含已构建的 host、客户端和类型声明，运行依赖仍需网络或已有缓存。
安装范围不等于所有组合已经通过业务验收；缺少原生面板服务时会提示升级宿主。

## 验证边界

完整源码 1156 项、typecheck、27 项插件契约及既有 E2E / 审计结果保留于本轮记录。
分页按钮位置微调后，新候选已重过 build、18 项原生加载契约、13 项 package 契约与 doctor，
并通过宿主 `dsh plugin add` 更新；未宣称重新执行完整源码 suite。
r3 浏览器报告记录模型 / 任务写入尝试为 0、errors 为空，详情 Escape 与焦点返回通过。
r3 follow-up 已通过真实宿主设置切浅色 / 深色，以及关闭重开设置后的选中状态回读。
会话字号 14→15 使 composer 14px→15px，面板与原生 chrome 保持 14px，并恢复原值；
这是宿主“仅影响会话内容”的设置，跨 runtime 重启持久性未测。
当前包已通过原生 fresh profile 的真实来源与公开集合扩展检查；扩展数据明确为 DEMO。
同包 420px 任务 / 海域预览完成，无 overlay、聊天保留。修后性能为 14 pass / 0 fail / 3 pending，
无 page / console 错误、writes 0；未覆盖真实团队详情、物理 GPU、整 tab 卸载与 OS 后台。
已补充 `CHROME_PATH=/usr/bin/chromium` 配置下 E2E 3/3、skip 0；
生产与全依赖公告审计均为零命中，仅代表当前锁文件的公告检查范围。
最终包校验值、输入摘要与分组计数见 [beta.14 发布说明](docs/releases/2026-11-17-beta14.md)。

Host owner 声明不能替代系统账号隔离或成员级 ACL，writeScopes 只是提示。
真实模型任务、完整多 Session 协作、多 Host 业务与升级恢复矩阵仍待独立验收；
跨 Host fencing 租约、绑定精确代码版本的独立 reviewer 和候选补丁自改进尚未交付。
既有公开任务视图扩展契约保留，扩展对应集合视图，不是单条任务详情；
生命周期已恢复并通过上述原生加载契约及显式 DEMO 扩展运行检查；不声明所有第三方扩展兼容。
候选包身份、历史 UI 范围与未覆盖项见发布说明。
[公开来源](PUBLICATION.md)说明本仓库如何排除私人运维历史。

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
