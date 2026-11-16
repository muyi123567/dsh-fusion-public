# Whale habitat 独立验收

仅在父代理授权的 Instabox 执行。CUE 只保存源码；本脚本不安装依赖、不启动服务、不构建、不伪造任务数据。父代理先完成冻结构建并提供正在运行的真实面板 URL。

## 运行

使用已有 playwright-core 和 Chromium：

```sh
WHALE_HABITAT_URL=http://127.0.0.1:4173/实际面板路径 \
WHALE_EVIDENCE_DIR=/tmp/whale-habitat-qa/run-唯一编号 \
WHALE_QUALITY_STORAGE_KEY=实际质量偏好存储键 \
CHROMIUM_PATH=/usr/bin/chromium \
node tests/whale-habitat-qa.mjs
```

WHALE_QA_DURATION_SECONDS 默认 90，不允许小于 90。环境中断导致长测未完成时不得声称通过，保留已生成 JSON；强杀进程可能没有最终 JSON。每次使用独立证据目录。

## 整合观测约定

以下是验收脚本期望的接口，尚不代表界面已经实现；父代理整合时须与界面路由核对。WHALE_QA_SELECTORS 可提供 JSON 对象覆盖 root、quality、toggle、poster、task、detail 六个 CSS 选择器，不允许用 mock 节点冒充应用接口。

- root 默认 data-testid=whale-habitat，唯一。其 data-frames、data-elapsed 对应实际渲染帧和连续动画秒数，暂停时不增长；data-quality 是用户所选 auto/balanced/eco/still。计数不能由独立测试定时器产生。
- quality 默认 data-testid=whale-habitat-quality，原生 select，值与公共 HabitatQuality 一致。
- toggle 默认 data-testid=whale-habitat-toggle，点击切换暂停/继续。
- poster 默认 data-testid=whale-habitat-poster，静态或减动画下可见。
- task 默认 [data-testid="whale-task"][data-source="live"]，必须来自真实快照，具备 data-task-id。detail 默认 data-testid=whale-task-detail，打开后同一 data-task-id，Escape 关闭。没有真实任务时该项失败，不能拿合成展示通过。
- WHALE_QUALITY_STORAGE_KEY 必须是应用实际使用的质量偏好键，其 still 值必须在首次渲染前生效。若实现使用其他序列化格式，先更新验收适配，不能填写虚构键使其看似通过。

## 自动覆盖与证据

1536×960、1280×720、390×844 各覆盖无页面/console 错误、无文档横向溢出、单 Canvas、质量选择、暂停/继续、真实任务详情、still poster、恢复、隐藏及离屏停帧。1536 宽视口每秒记录至少 90 秒 frames/elapsed，覆盖 36 和 72 秒边界，任何倒退或停滞失败。减动画和冷启动 still 用新 context 检查 poster、零 Canvas、无 GLB/GLTF/KTX 请求。

result.json 保存用例状态、帧样本、错误、浏览器版本和限制；PNG 保存各尺寸运行、暂停、任务、静态及长测画面。失败退出 1，全部自动断言通过退出 0。缺少遥测、控件、真实任务、偏好键或浏览器环境均不能通过。

hidden 用 visibilityState/hidden 覆盖并发送 visibilitychange，离屏把真实根节点移到视口外；二者验证调度响应，但不能代替真实系统切后台、最小化和滚动容器场景。静态资源匹配仅覆盖常用扩展，需人工核对无扩展模型端点。

## 父代理仍需验证

- 实际构建和 Instabox 执行；脚本编写/提交不算验收通过。
- 检查截图中的鲸形、文字遮挡、真实来源、空/陈旧来源标识以及任务入口可用性。
- 实际系统后台、滚动离屏、恢复、反复挂载卸载资源回收，检查 textures/geometries/programs 是否回落。
- 观察帧预算降级、balanced 24fps/eco 15fps 上限及 GPU 场景；单调计数不能证明视觉轨迹无跳变，需复核 36/72 秒边界画面。
- 软件 WebGL 的帧增量或帧率只证明该环境的渲染行为，不能宣称真实 GPU 帧率、功耗或节能收益。
