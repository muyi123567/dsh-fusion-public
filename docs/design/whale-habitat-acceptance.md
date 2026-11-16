# Whale habitat 独立验收

仅由父代理在授权 Instabox 上使用已有 playwright-core、Chromium 和已构建服务运行。CUE 只编辑源码。本脚本不启动服务、安装依赖或发起任务执行。

## 运行

```sh
WHALE_HABITAT_URL=http://127.0.0.1:4173/实际面板路径 \
WHALE_EVIDENCE_DIR=/tmp/whale-habitat-qa/唯一运行编号 \
CHROMIUM_PATH=/usr/bin/chromium \
node tests/whale-habitat-qa.mjs
```

WHALE_QA_DURATION_SECONDS 默认 90，不能低于 90。多视口及状态等待使整个运行可能超过 240 秒；父代理可在 Instabox 后台运行并轮询日志及 result.json，不要把单次工具等待超时当作脚本超时。每个用例完成即保存 status=running 的阶段 JSON，最终写入 passed/failed，失败退出 1。进程被强杀时阶段 JSON 不代表完成。

## 实际 UI 与数据边界

- root 为 .whale-habitat，读取 data-habitat-state、data-habitat-quality、data-habitat-frames、data-habitat-elapsed。
- quality select 为 [aria-label="海域画质"]，选项 auto/balanced/eco/still。auto 的根属性是实际 balanced 或 eco；同时检查 select 保留 auto。
- 按钮通过可访问名称“暂停海域”“继续海域”定位；poster 为 img.whale-habitat__poster。
- 任务按钮可访问名称前缀“打开任务”且有 data-task-id，详情为 dialog[aria-label="预览详情"]，检查相同 data-task-id。
- 公开 fixture 是合成数据。任务项只验证 fixture 的点击、详情身份和关闭，不要求 data-source=live，不证明真实任务来源或远程执行。
- cold still 在新 context 首次导航 URL 上设置 quality=still，不读取或编造本地存储键。
- WHALE_QA_SELECTORS 可用 JSON 覆盖 root、quality、pause、resume、poster、task、detail；仅用于实际界面适配。

## 自动覆盖

1536×960、1280×720、390×844：页面及 console 无错误、无横向溢出、单 Canvas、质量选择、暂停/继续、合成任务详情、still/poster、hidden/离屏停帧及恢复。开始和每次恢复先等待 state=running 且 frames>0，再采样帧增量。

1536 宽视口每 2200ms 采样至少 90 秒 frames/elapsed，覆盖 36/72 秒边界，停滞或倒退失败；计数单调不能独自证明视觉轨迹连续，边界画面仍需人工复核。

减动画和 cold still 使用独立新 context：poster 可见、frames=0、没有成功创建 WebGL context、没有 GLB/GLTF/KTX 或可识别 habitat/ambient scene 请求。Canvas 元素可以存在；context 观测调用原始 getContext 并保留返回值，不用假渲染替换应用。

Chromium 显式使用 --use-gl=angle、--use-angle=swiftshader、--enable-unsafe-swiftshader。所得帧增量仅代表软件 WebGL 环境，不能宣称真实 GPU 帧率、功耗或节能收益。

## 证据与剩余人工验收

result.json 包含逐用例状态、帧样本、错误、浏览器版本与限制；PNG 包含各尺寸运行、暂停、任务、still、长测及减动画画面。自动断言全部通过才退出 0。

hidden 通过覆盖 visibilityState/hidden 并派发事件，离屏通过把真实根节点移到视口外验证；真实系统切后台、最小化及滚动容器行为仍需父代理验收。还需检查截图可读性、36/72 秒视觉连续性、空/陈旧来源标记、资源回收、实际帧预算降级与质量帧率上限。资源 URL 匹配不穷尽所有无扩展端点，需结合网络记录核对。

本轮仅交付脚本与文档；构建、运行及 Instabox 截图结果由父代理验证。

## 2026-11-17 鲸群提示词验收增量

依据已完成的 2026-11-17-magpie-research.md 与 2026-11-17-whale-pod-prompt.md。本轮不运行测试，父线在 Instabox 执行。

- 每个尺寸分别记录深海和海面截图；首帧 running 后稳定等待并确认帧增量才截图。切换前后 elapsed 不倒退，任务选择保持同一团队 ID 及同一任务 ID；仍断言单 Canvas。
- 任务列表按需展开：先点名称以“任务”开头的按钮，再使用“筛选团队”选择真实存在于合成 fixture 的团队，点击任务并核对详情 ID。WHALE_QA_TEAM_TASK_IDS 是父线从独立 fixture 定义提供的 JSON 对象（团队 ID → 任务 ID 数组），用于验证展示任务确属该团队；缺少映射记 incomplete，不能把选择框值本身当作归属证明。
- 深海/海面默认通过可访问名称包含“深海遨游”/“海面呼吸”的按钮定位。这两个名称是提示词适配默认值，当前基线尚未提供控件，父线应核对整合后的实际名称并通过 WHALE_QA_SELECTORS 的 deep/surface/tasksTab/team/preview 字段覆盖，不宣称它们已经实现。
- WHALE_QA_METRIC_ATTRS 是 JSON 对象，whales/renderers 分别填写实际 UI 暴露的属性名。指标必须由场景实际鲸实例和 renderer 生命周期提供；不在 QA 中造值。三个团队的 fixture 应显示 3 只鲸且最多 3 只、仅 1 个 renderer。未提供指标映射时记录 gap，最终 incomplete 且退出 1，父线补齐后重跑。
- 长测不少于 90 秒，frames/elapsed 不倒退；允许连续几次样本没有新帧，但连续 10 秒无帧失败。以每段遥测 elapsed 增量检查 24fps 上限，容许 2 帧采样边界误差；elapsed 不可快于可见墙钟。这里检查上限和持续性，低帧率不是失败原因。视觉上不重播 36 秒入水仍需核对录像。
- empty/stale/unobserved 通过现有“预览状态”select 本地切换并截图，检查文字解释、空状态无任务，监听该交互不引发 fetch/XHR 数据请求。静态质量下进行这些状态检查，避免场景懒加载与数据请求混淆。
- 原有画质、暂停/继续、hidden、离屏、减动画、cold still、页面错误和横向溢出检查保留。场景喷气的短促、非同步、露出呼吸孔再喷气及任务语义不随呼吸伪造，需父线视觉验收。
- 公共数据始终标记 synthetic-public-fixture，只验证映射和详情交互，不能称真实任务执行或跨集群业务验收。

脚本不设置 240 秒总时限；父线可后台运行，轮询逐用例日志与阶段 JSON。gaps 未清零时不能称完整通过。

DOM 帧遥测约每秒上报，长测 2200ms 采样且允许短暂相同样本，按 reported elapsed 的差值评估帧率，避免上报边界误报。每次 advancing（包含恢复）先 root.scrollIntoViewIfNeeded。hidden 覆盖仅用于当前一次性测试 context，不能外推为系统后台实测。scene.getMetrics 的扩展与 DOM 指标接线待父线，缺失如实记 gap。
