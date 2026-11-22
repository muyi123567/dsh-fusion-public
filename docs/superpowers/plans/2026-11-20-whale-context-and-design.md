# Whale 协作上下文与界面对比实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 补齐任务上下文与恢复可靠性，并交付三个可交互的原生工作台设计候选。

**Architecture:** 沿用上游任务权威、现有 adapter、FleetRouter 和 ledger。增加可选只读正文投影，修复活跃记录保留，设计候选独立于 production native 入口。

**Tech Stack:** TypeScript、React 18、Vite 7、Vitest 4、Node 24.11.1、pnpm 11.21.0；不新增产品依赖。

**Spec:** `docs/design/2026-11-20-collaboration-control-plane.md`

## Global Constraints

- 本机隔离副本 `/home/ubuntu/dsh-fusion`，基线 `db0cfad2ac5f7cb4f3f81845698966580f0d3e4d`。
- 不操作真实 DSH profile、远程节点、付费模型、发布/tag/production；不新增第二套任务权威。
- 新增字段可选；保留缺席、明确空串和多行文本语义。
- 数据为合成的预览不冒充真实宿主、业务执行或验收证据。
- 长运行通过 tmux，日志位于 `/data/openlet/logs/dsh-fusion-20261120`。

## Review Focus

- 有标题时正文仍应保留；HTML 类内容只作为文本渲染。
- ready 未提供与 false 分开；writeScopes 不能被显示为文件锁。
- 超过 200 个活跃任务不能被历史上限裁掉；恢复后主机配额保持。
- 预期证据不等于已提供、更不等于独立审查通过。
- 420px 交互没有不可见按钮、横向溢出或丢失的返回路径。

## Task 1：无损正文投影

- [x] native 与 legacy bridge 先写正文/空值/输入不变回归，确认因字段缺失失败。
- [x] TaskRecord 新增 `description?: string`，mapper 原样投影；保留 legacy goal 回退。
- [x] 聚焦测试通过，交由独立 reviewer 检查缺席语义。

## Task 2：活跃任务恢复

- [x] 复现旧 running 与 200 个新终态共存时丢记录。
- [x] 仅终态历史计入 200 条，维持全局时间排序。
- [x] 覆盖全部非终态、205 活跃任务、混合终态排序和磁盘恢复后的并发准入。

## Task 3：原生上下文与独立视觉候选

- [x] 原生详情补正文、owner/revision/ready、写范围警告和预期证据，先写可失败的用户行为回归。
- [x] 独立 `workbench-preview.html` 提供 panorama / ocean / focus，同一数据与草稿。
- [x] 先保存 beta.14 组件基线截图，再检查三方案桌面/窄屏、明暗和证据交互。
- [x] 不改 production native 入口；保留选择与发布边界。

## Task 4：统一验证与交付

- [x] 重建共享依赖，执行 typecheck、完整源码测试、插件 build、doctor 与包契约。
- [x] 执行浏览器交互、检查 console/page errors、截图和网络边界。
- [x] 独立复核所有生产改动与候选，记录实际通过和未覆盖项。
- [x] 保存精确源码差异/工具版本/命令/退出码/证据 hash；只在实际完成时标记对应步骤。
