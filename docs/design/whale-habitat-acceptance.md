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

1536 宽视口每秒采样至少 90 秒 frames/elapsed，覆盖 36/72 秒边界，停滞或倒退失败；计数单调不能独自证明视觉轨迹连续，边界画面仍需人工复核。

减动画和 cold still 使用独立新 context：poster 可见、frames=0、没有成功创建 WebGL context、没有 GLB/GLTF/KTX 或可识别 habitat/ambient scene 请求。Canvas 元素可以存在；context 观测调用原始 getContext 并保留返回值，不用假渲染替换应用。

Chromium 显式使用 --use-gl=angle、--use-angle=swiftshader、--enable-unsafe-swiftshader。所得帧增量仅代表软件 WebGL 环境，不能宣称真实 GPU 帧率、功耗或节能收益。

## 证据与剩余人工验收

result.json 包含逐用例状态、帧样本、错误、浏览器版本与限制；PNG 包含各尺寸运行、暂停、任务、still、长测及减动画画面。自动断言全部通过才退出 0。

hidden 通过覆盖 visibilityState/hidden 并派发事件，离屏通过把真实根节点移到视口外验证；真实系统切后台、最小化及滚动容器行为仍需父代理验收。还需检查截图可读性、36/72 秒视觉连续性、空/陈旧来源标记、资源回收、实际帧预算降级与质量帧率上限。资源 URL 匹配不穷尽所有无扩展端点，需结合网络记录核对。

本轮仅交付脚本与文档；构建、运行及 Instabox 截图结果由父代理验证。
