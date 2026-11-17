# 🐋 鲸项目状态

## 当前候选：0.2.0-beta.14

2026-11-17，候选入口已接入 DSH 原生右栏，默认任务，提供主机、团队与按需海域。
任务、主机和团队详情在同一面板内导航；标签、关闭和宽度由宿主管理，主题与字体继承宿主。
当前快照属于 Fusion 全局来源，不是当前会话专属数据；团队归属采用 `AgentTeam.taskIds`。
复用上游任务与协作原语，不创建第二套调度或验收权威状态。
本版是可试验的原生面板预发布，默认用于查看与证据导航；旧 FusionApp 的派发、配置、
运行与终端组件及 host API 保留，尚未全部迁入新入口，不承诺与 beta.13 UI 完全等价。
已发布 beta.13 包与用户 production 保持不动。既有任务视图扩展契约保留，
集合视图接入的生命周期已恢复并通过 18 项原生加载契约及本次显式 DEMO 扩展实际运行检查，
不改成单任务详情扩展，也不删除既有承诺。

当前发布候选 SHA-256：`3a317257ceb5e4f77b756c9e72a63530e56e73146109ecd5613163385139ee26`，已公开为 GitHub 预发布。
海域分页按钮已移至左侧组中，避免 AgentBus 固定右侧 capsule 拦截；仅调整按钮位置。
新包已由官方 `dsh plugin add` 更新，退出 0，模块 / schema / activation 错误标记均为 false；
build、18 项原生加载契约、13 项 package 契约与 doctor 重验通过。
本轮完整源码测试仍为 1156，typecheck、27 项插件契约及其它既有门禁结果继续保留，
未将此次最小复验写成重新跑过完整 suite。
源码分组：root 68、core 33、config 3、client 378、host 337、plugin 337，合计 1156。
分页位置调整前，CUE / Instabox 的全部 packages 输入摘要一致：
`26825881c3c02564d8425cc1484b1605f32e9420d7da55ffd8e4873479e46cf4`。
该历史摘要不作为新候选输入身份；新摘要待来源收据更新，不替代完整公开来源清单或运行验收。
既有 E2E 在 `CHROME_PATH=/usr/bin/chromium` 下 3/3 通过、skip 0；
生产依赖审计退出 0，58 项依赖的五级 vulnerabilities 均为 0。
全依赖 `pnpm audit --json` 同样退出 0，dependencies 58、dev 221、optional 56、total 279，
五级 vulnerabilities 均为 0；仅表示当前锁文件公告检查无命中，不代表源码零漏洞。

父路回读的 r3 实际 UI 报告记录：modelRequests 0、taskWrites 0、errors 空，
realStateResponses 3，Escape 返回和焦点恢复均为 true，入口为 r3 footer launcher。
已有 384 / 420 窄面板的任务、详情、主机、团队、海域截图。
r3 follow-up 报告为 passed，仍对应 r3 包，modelOrTaskWriteAttempts 0、errors 空。
真实 native-settings 切浅色 / 深色与同一 runtime 内关闭重开设置后的选中状态回读已通过。
会话字号 14→15 使 composer 14px→15px，面板与原生 chrome 保持 14px，并恢复原值；
设置明确只影响会话内容，跨 runtime 重启持久性未测。
任务→主机 / 团队→原任务 / 列表、Escape 后详情消失及原行焦点、证据 href 与新窗口属性、
关闭重开后的 session / tab 关联及未发送草稿保留均有记录；证据 URL 未打开。
较早 `8447…` 候选在 `ui-qa-final-parent` 通过 fresh profile 来源提示与显式 DEMO 集合扩展，
420px push 与聊天共存、6 task / 3 node topology、dispatch / cancel 未提供；四个 chunk 字节匹配，
错误 / 写入计数 0，前后实际 tasks 0。同包 `ui-qa-final-previews` 的任务 / 海域截图
`QA_EXIT=0`、writes 0、pageErrors 0，无 overlay、聊天保留。上述均为历史候选结果。
当前 `3a317…ee26` 候选的三组 `ui-qa-publish-*` 均已完成，全部 `QA_EXIT=0`、`DSH_STOPPED=True`。
真实来源 + 公开扩展为 passed；修后性能 / 分页为 14 pass / 0 fail / 3 pending，
无 page / console 错误、writes 0；420px DEMO 任务 / 海域截图完成，无 overlay、聊天保留。
三个 pending 为真实团队详情、物理 GPU、整 tab 卸载与 OS 后台行为；不将其写为已覆盖。
当前包按原生 fresh profile、真实来源与显式 DEMO 扩展 / 场景范围验收；
r3 主题、详情和其它尺寸是先前独立记录，未在当前包全量重跑。

主机来源不可用与合法空板的区分已在 `e9f3910` 实现，公开 taskView 生命周期已在
`e3c7de1` 恢复。本次三组最小实际复验已完成；新包来源摘要与公开证据由维护者统一归档。
兼容元数据已更新为 recommended / tested 仅 0.2.2-rc.3，candidates 为
0.2.0-rc.2 / 0.2.2-rc.1，安装范围不变；更新后的源码与包契约已通过。
rc.3 verified 仅依据隔离启动 / 原生 UI 范围；旧宿主 API 已核实存在，不标 unsupported，
但 beta.13 的 rc.1 历史 verified 不覆盖 beta.14 与旧宿主的运行组合。
最终包 SHA-256、输入摘要与逐项边界见 [beta.14 候选发布说明](../releases/2026-11-17-beta14.md)。

beta.13 → beta.14 通过宿主安装并重载目标 profile，升级前备份并保留旧包。
面板使用无需开启模型，模型写入和远程终端仍默认关闭；本轮没有 production 改动。
SSH 可达不代表 PTY 已登录，任务完成或子代理空闲不代表独立验收通过。
真实模型任务、完整多 Session / 多 Host 业务协作、升级恢复矩阵仍待验收；
fencing 租约、绑定精确代码版本的独立 reviewer 和候选补丁自改进仍属后续工作。

[产品说明](../design/2026-11-17-native-panel-product.md) ·
[原生验收方法与待覆盖项](../design/2026-11-17-native-panel-acceptance.md)

## beta.13 历史记录

2026-11-16 的 beta.13 完成三版布局比较及当轮截图、安装与契约验证，
历史产物和哈希见 [beta.13 发布说明](../releases/2026-11-16-beta13.md)。
这些记录属于旧安装包，不作为 beta.14 原生右栏的通过证据。

后续独立「鲸入深海」动态原型及鲸群场景预览使用显式合成情境，
不代表真实多集群执行或当前原生面板已经验收。
原始比选、提示词与验收资料继续保留在 docs/design；当前产品以原生面板候选为准。

公开预发布：https://github.com/muyi123567/dsh-fusion-public/releases/tag/v0.2.0-beta.14
