# 任务优先快速展示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.  
> **执行时**遵守当前工作区约束；本轮保持独立设计稿，不接生产入口或真实执行服务。

**Goal:** 为任务优先独立设计稿增加可控、可访问、约15秒的合成数据导览。

**Architecture:** StudyHarness 持有导览步骤、可见性暂停、减少动态效果与启动/暂停/继续/逐步控制。TaskStudy 按受控步骤切换列表和详情；TaskDetail 只在局部标注缺口与证据焦点。任何任务面板用户操作退出展示。

**Tech Stack:** React 18、TypeScript、CSS、Vitest、Testing Library、Playwright Chromium；不新增依赖。

**Spec:** `docs/design/2026-11-20-presentation-tour.md`

## Global Constraints

- 只使用固定合成任务数据。
- 不改变来源任务状态、证据正文、执行状态或验收状态。
- 不新增真实调度/派发/回执请求。
- 保留现有420/560/850容器和任务详情交互。
- 减少动态效果时不自动播放或做位移动效。
- 面板内用户输入、点击、键盘或滚动操作停止自动导览。
- 浏览器页面隐藏时暂停倒计时。

## Review Focus

- 15秒顺序与结束文案不得暗示任务执行或验收通过。
- 人工交互后导览必须停止且保留用户选择。
- reduced-motion 下禁止自动计时与CSS位移。
- 页面隐藏时间不计入导览阶段时长。
- 详情切换和滚动不移动焦点；Escape既有保护继续有效。

## 文件职责

- `packages/client/src/features/design-study/StudyHarness.tsx`：审稿入口的导览控制与媒体偏好。
- `packages/client/src/features/design-study/TaskStudy.tsx`：展示步骤与普通交互退出边界。
- `packages/client/src/features/design-study/TaskDetail.tsx`：缺口、证据步骤的局部展示标记及明确结束状态。
- `packages/client/src/features/design-study/design-study.css`：单次克制强调与减少动态效果规则。
- `packages/client/src/features/design-study/StudyHarness.test.tsx`：时间顺序、用户中断、reduced-motion、隐藏页暂停。
- `packages/client/src/features/design-study/TaskStudy.test.tsx`：现有任务选择、Escape、证据阅读回归。
- `docs/design/2026-11-20-presentation-tour.md`：已确认的行为边界。

### Task 1: 可控导览行为

- [x] 写4项失败测试，覆盖阶段顺序/结尾事实、交互中断、减少动态效果手动步骤、后台暂停。
- [x] 确认新增测试先因导览控件/状态不存在而失败。
- [x] 实现计时、暂停/恢复、用户中断和手动逐步展示。
- [x] 实现局部强调、证据定位与reduced-motion样式。
- [x] 重跑新增测试、现有TaskStudy测试、typecheck和client build（14 passed、build exit0）。
- [x] 用浏览器验证420/560/850浅色/深色展示、暂停与用户中断并保存截图。
- [x] 更新 `/home/ubuntu/dsh-fusion/design-qa.md` 与证据manifest，明确动画仅属合成展示层。
