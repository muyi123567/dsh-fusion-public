# 多机协作插件同类调研（2026-11-22）

状态：只读公开信息调研，不构成功能、质量或安全背书。星数、更新时间为 2026-11-22 的
GitHub API 快照；只阅读了仓库描述与 README，没有逐仓审计源码或实际安装运行。

## 结论

DSH 生态里已经有多个“多机 / 多主机”插件，但它们集中在**连接、巡检、终端与运维**，
没有一个同时提供本项目的核心闭环：原生任务 revision 绑定、单次 attempt 隔离工作区、
材料 v2 回执（code/input/runtime/config/artifact 摘要）、签名复核及过期判定。

因此不构成重复实现，本项目继续走“可解释的执行与验收”差异点，不跟进做第二套
通用 SSH 面板、密码库或消息总线。

## 直接同类

| 仓库 | 快照 | 定位 | 与本项目重叠 | 本项目仍不同 |
| --- | --- | --- | --- | --- |
| [loveXbanshee/dsh-fleet](https://github.com/loveXbanshee/dsh-fleet) | 1★，2026-09-06 | DSH 多机指挥台：右栏设备列表、原地切换远程 DSH、跨设备历史会话、远程刷新/重启 | 右栏多机视图、主机忙闲状态 | 无任务台账与执行回执；无 allowlisted 作业；无签名复核 |
| [Sunnnnch/dsh-constellation](https://github.com/Sunnnnch/dsh-constellation) | 1★，2026-11-13 | SSH/VPS 资产面板：主机清单、状态曲线、终端、SFTP、隧道、左侧栏整页入口 | 主机清单与右栏面板、SSH 执行 | 面向服务器运维，不绑定 DSH 任务 revision，不产生执行证据链 |
| [wisp-science/WispOps](https://github.com/wisp-science/WispOps) | 2★，2026-10-30 | 多主机运维：巡检、磁盘/安全分析、定时报告、独立密码库、逐主机 sudo 授权 | 多主机巡检、SSH 能力协商、批量操作 | 无任务 attempt/回执/复核模型；授权对象是运维动作而非任务交付 |
| [tangwenhao616-netizen/dsh-anywhere](https://github.com/tangwenhao616-netizen/dsh-anywhere) | 1★，2026-08-18 | NAT 机器入网（反向隧道）+ 把远端变成会话 workspace（fs/subprocess） | 远端可达性与执行位置 | 目标是“远端即工作区”，不记录任务来源、材料 pin 或复核结论 |
| [yechao666/dsh-cow](https://github.com/yechao666/dsh-cow) | 0★，2026-11-19 | 纯消息多机协作：WebSocket 长连接、dispatch/complete/ask/answer、文件 sha256、升级与出口代理 | 跨机派发与完成回报 | 明确“只有消息，没有任务层”；不保存 attempt、材料摘要或签名复核 |

## 相邻但不属同一层

- 多 agent 终端管理：[claude-squad](https://github.com/smtg-ai/claude-squad)（8.8k★）、
  [agent-deck](https://github.com/asheshgoplani/agent-deck)（1.3k★）：管理本机多个 agent 会话，
  不解决跨主机任务交付与证据。
- 任务看板/编排：[vibe-kanban](https://github.com/BloopAI/vibe-kanban)（28.8k★）、
  [squadra](https://github.com/dagoSte/squadra)（982★）：面向多 agent 工作流与代码合并，
  不提供 DSH 原生右栏、主机能力解释或执行回执。
- 名称相近但不同产品：[yuchen1017918/dsh-fusion](https://github.com/yuchen1017918/dsh-fusion)（Android DSH 融合包）、
  [aa2246740/dsh-model-fusion](https://github.com/aa2246740/dsh-model-fusion)（模型分工），
  与多机协作无关，仅名称冲突。

## 对本项目的取舍

1. **不重复造通用 SSH 面板。** Constellation / WispOps 已覆盖终端、SFTP、隧道、密码库；
   本项目只在任务执行需要的范围内保留 SSH/Instabox adapter。
2. **不重复造消息总线。** dsh-cow 已覆盖跨机消息、询问、文件与升级；本项目继续使用
   FleetRouter 单 attempt 绑定单 worker，不新增第二套调度器。
3. **继续补强唯一闭环。** 离线校验签名复核（`--verify`）、回执与任务来源绑定、
   attempt 隔离工作区与材料摘要，是当前生态中没有对应实现的差异点。
4. **明确未覆盖的短板。** NAT 入网、终端/SFTP、定时巡检报告、密码库都不在本项目范围；
   若真实用户需要，应先给出失败案例与权限边界，再单独评估，不因“竞品有”而顺手添加。

## 边界

公开 README 只能说明作者声称的能力，不能证明其实现质量、安全性或真实多机可用性；
星数与更新时间也不代表成熟度。本调研的用途仅是判断“是否重复造轮子”，不用于对外比较宣传。
