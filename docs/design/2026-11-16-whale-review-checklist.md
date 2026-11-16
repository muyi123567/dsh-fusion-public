# 鲸深海面板：三版审查与 Instabox QA

状态：工具已准备；尚未运行。截图/视觉结论、候选内部按钮、生产宿主回归均不能视作通过。
本路只维护 tests/whale-design-review.mjs 与本清单。代码先行，先比较三版，再由主线程整合正式入口。

## 执行边界

- 源码仅 CUE /home/ubuntu/dsh-fusion-public，分支 feat/whale-panel，经买机访问。
- 所有构建、依赖、语法检查、浏览器与截图仅已授权 Instabox。脚本不启动服务器、不安装依赖、不配置模型、不提交/push、不部署。
- 本机仅只读、远程控制与转发；不得用本机 IAB、Node、WSL 或 Docker 测试。
- 使用仓库已有 playwright-core 和 Instabox /usr/bin/chromium（可用 CHROMIUM_PATH 指向既有 Chromium）。
- 脚本要求 Linux 与 WHALE_TEST_MACHINE_ID=authorized-instabox。该变量是主线程核验后填写的声明，不能代替 Instabox API 的机器身份验证。
- 每个用例使用独立浏览器 context；GET/HEAD/OPTIONS 以外请求被阻止并记为失败。只检验本地选择与导航，不派发任务或访问额外资源。浏览器的正常页面/资源读取属于预览。
- 新增证据仅 /tmp/whale-design-review/<UTC run>/，不进入仓库或本机。

## 主线程可立即调用

先把冻结源码及本脚本同步到 Instabox，并启动主线程已有预览。以下命令只在 Instabox 执行：

~~~sh
WHALE_TEST_MACHINE_ID=authorized-instabox \
WHALE_BASE_URL=http://127.0.0.1:4173 \
node tests/whale-design-review.mjs
~~~

4173 是可替换的临时端口；主线程指定的端口覆盖示例。省略 WHALE_BASE_URL 时默认 http://127.0.0.1:4173。
脚本固定访问 /design-gallery.html?whaleGallery=1&whaleDesign=atlas、bridge、current。
main FusionApp 默认 ocean，不能拿首页截图当三候选已渲染。
三个设计均在 desktop 1536×1024、narrow 1280×900、mobile 390×844 上取证，DPR=1、zh-CN、Asia/Shanghai。
不用 networkidle：页面可能有轮询或流；等明确可见区域、字体和两个 animation frames。

输出：

- 每个候选/视口：viewport.png、full-page.png、keyboard-first.png、reduced-motion.png、interaction-N.png、evidence.json；失败时尽力保存 failure.png。
- report.json：原始错误、HTTP/请求失败、写请求拦截、字号与触达、焦点轨迹、动效、具体失败和未覆盖项。
- summary.md：矩阵与状态；stdout 最后一行输出路径及统计。
- 退出码 1=发现问题/运行失败，2=已有取证但仍缺交互或宿主等覆盖，0=自动检查无已知失败或缺项。0 也不替代人工视觉、数据真实性与真实宿主业务验收。
- 持续保存每用例证据；浏览器启动失败亦应保存总报告。外部强杀可能留下不完整 run。

## 已确认的 DOM 契约

已读取 WhaleGallery.tsx 与 WhalePanel.tsx：

| 区域 | 默认检查 |
| --- | --- |
| 方案导航 | nav[aria-label="设计方案"]，按钮可访问名称含鲸群航图/深海舰桥/洋流矩阵，当前项 aria-pressed=true |
| 候选根 | section[data-whale-design="atlas 或 bridge 或 current"]；源代码 aria-label="鲸 · 深海工作面板" |
| demo | 根内 .whale-panel-source > span:first-child 明示演示/合成 |
| 空海域 | label 文本空海域内 checkbox，点击后来源显示等待首次观测 |
| 连接中断 | label 文本连接中断内 checkbox，点击后显示连接中断 |
| 方案切换 | 点击另一个已确认导航按钮，等待对应 data-whale-design 根可见 |
| 任务/主机详情 | section[aria-label="预览详情"]；按钮真实 selector 等候选冻结后提供 |

每个交互从该候选 URL 重新加载；断言实际可观察的 before/after 改变，focus/hover/动画变化不能冒充按钮业务成功。
默认交互只覆盖上表已有展厅控件。搜索、团队选择、任务/Host 回调与候选所有按钮必须在冻结 DOM 后补；不得凭文案猜 selector。
无专用 contract 会如实记 gap，不能被截图存在或展厅 checkbox 的成功掩盖。

## 可扩展契约（无需改脚本、无新增依赖）

WHALE_CONTRACT_FILE 指向 Instabox 临时 JSON 文件，或 WHALE_CONTRACT_JSON 提供同结构。
根 key 为 atlas / bridge / current，可覆盖 root、ready、demoMarker、modelEvidence，并追加 interactions。
只填 worker 确认过且唯一的 selector。ready 是可选的可见就绪元素。
modelEvidence 是可选的序列化原始 WhalePanelModel JSON 元素 selector；不要求更改共享类型或生产 DOM。
不存在该元素时，由主线程核对三候选导入同一合成 fixture；脚本明确标记模型一致性待人工核实。
提供时脚本校验 demo=true、生成排序键 SHA-256，并逐视口比较三版哈希。

每个 interaction 包含 name、action、selector、expect。支持 click、fill、select、press；fill/select 的 value 为字符串，press 仅接受导航键。
expect 必须有唯一 selector，并至少提供 visible、count、text（规整空白后精确值）、includesText、value 或 attribute+equals。
多元素断言显式提供 count。每项独立从初始 demo 加载；多步业务流应待主线程补专用契约后实现，不能靠前一项遗留状态。

以下是可直接使用的空壳，不内置未确认候选 selector：

~~~json
{
  "atlas": { "interactions": [] },
  "bridge": { "interactions": [] },
  "current": { "interactions": [] },
  "host": {
    "launcher": "button[aria-label='打开鲸插件']",
    "close": "button[aria-label='关闭鲸插件']",
    "styleScopes": []
  }
}
~~~

## 生产 DSH scope 与外层浮窗

可选设置 WHALE_HOST_URL 为 Instabox 上已启动真实 DSH 预览的 loopback URL；没有该 URL 时明确 NOT VERIFIED。
不得给脚本提供生产外网、凭据 URL 或更改真实资源权限。host.launcher/close 是可覆盖的精确 selector，默认采用主线程告知的鲸命名。
host.styleScopes 仅在源码审查确认自有根后添加，不可为通过检查加入 body、html、:root、* 或空字符串。

~~~sh
WHALE_TEST_MACHINE_ID=authorized-instabox \
WHALE_BASE_URL=http://127.0.0.1:4173 \
WHALE_HOST_URL=http://127.0.0.1:3080/ \
node tests/whale-design-review.mjs
~~~

自动检查：真实 launcher 打开浮窗；role=dialog/aria-modal、焦点进入、正反 Tab 不逃出；关闭后返回 launcher。
在宿主 body 下插入临时、屏外、不接收指针的样式哨兵；对比 html/body/#root 与哨兵及子元素的字体、颜色、背景、box sizing、滚动条、动效、--fusion/--whale token。
分别保存打开前、打开后和关闭后；审查 style[data-plugin="dsh-fusion"] 的 CSSOM，标记不以自有 .fusion-/.whale- 或 overlay 根开头的 selector。
该 CSSOM 检查是启发式；后置兄弟选择器、:is/:where 嵌套或跨域样式需人工审查。样式表读取失败不能当安全通过。
截图宿主 overlay-open.png 与 overlay-closed.png。报告原始差异，正常宿主动态样式变化需人工解释，不静默忽略。

还需主线程人工执行：390px 导航/详情，背景 inert、焦点闭环、Esc 仅关闭顶层浮层、关闭恢复焦点；760/1120 跨断点无残留 scrim、滚动锁和 inert。
外层插件浮窗与内层 sidebar/drawer 均监听 Escape：旧源码存在一次 Escape 同时关内外层风险，待冻结代码云端确认。

## 初始源码审查及当前状态

本路初读时观察到以下问题，仅报告、不越界修改：

| 项目 | 初读事实 | 主线程更新/待验收 |
| --- | --- | --- |
| 宿主 CSS | tokens.css/design-refresh.css :root；app.css html/body/*；通用控件 focus 与全局 reduced-motion | 主线程已将 legacy globals 收到 .fusion-shell；本路已回读 app/design-refresh 看到 scope 修改，完整 bundle/host 样式差异仍待云端 |
| CSS 注入 | plugin/client.styles.ts 把 workspace CSS 注入 document.head，生命周期结束移除；旧构建不自动隔离 selector | 新 scoped 源码仍须检验构建实际注入结果 |
| 触达 | 旧 sidebar 导航36px、node/group34px、topbar32px、外层关闭34px | 主线程正在整合，最终 computed geometry 必须≥40×40 |
| 字号 | 旧 sidebar 标签9–11px、正文13px | 正文≥13（推荐14）、次要≥12；最终截图与文本节点报告复核 |
| 激活语义 | 旧 Sidebar 只用 is-active class | 需核验 aria-current/pressed/selected、键盘可发现性，不能只用色彩 |
| 群聊按钮 | 旧 Sidebar onClick 仅 agent-room 分支执行，demo group 可能静默无操作 | 正式空/unsupported 应说明原因，不保留可点但无响应按钮 |
| 浮窗语义 | Sidebar/RightDrawer 已有 trap/return/inert 单测，外层 overlay 有独立 trap | 单测未在本路执行；真实嵌套 Chromium 行为仍待主线程 |
| 侧栏导航 | 旧主显示 DSH FUSION，launcher 旧 aria 打开 DSH Fusion | 主线程已改鲸品牌与打开鲸插件；脚本默认采用新名称 |
| 溢出 | 旧 shell height/max-height 100vh + overflow hidden | document 无横向滚动不代表内容未裁剪；元素 rect/内部 scroller 与截图一起看 |

## 冻结后逐项验收

- [ ] 三版均使用同一 WhalePanelModel/fixture；首 render data-whale-design 与导航 pressed、URL 对应；不得三张截图其实同一设计。
- [ ] 是工作面板，任务/团队/Host 信息与动作优先，避免宣传页式巨幅 hero 占首屏。
- [ ] Host 不等于 Team；鲸/磷虾实体身份、来源和实际关系保留；不按随机坐标或装饰洋流暗示真实链路。
- [ ] TaskStatus 仅 queued/claimed/running/verifying/completed/failed/cancelled。受阻读 task.blocked，不用 status==="blocked"；projection attention 可读 blockedsignal。
- [ ] CPU/内存/进度只编码真实 model 已报告数值；undefined 显示未知/未报告，不能补0、随机数、虚假百分比/时序/延迟。
- [ ] 合成 demo 明示；current/stale/unobserved、合法空数据、来源断线与未知归属各有明确文字，不以零任务证明已连接。
- [ ] 首屏、长名称、长路径、多团队/大量磷虾、无归属/未知 Host 状态都检查；压力 fixture 需主线程提供真实测试入口，本脚本不假造数据。
- [ ] 搜索输入后结果确实缩小/无结果可解释；清除恢复；团队选择后 scope/aria 与任务集合一致；先等 worker 确认 DOM。
- [ ] 每个可见按钮有本地选择或 onOpenTask/onOpenHost/onNavigate 的可观察回调结果；任务点击出现预览详情并能关闭。
- [ ] 交互成功不能仅凭焦点、hover、动画或 URL query 改变；拿具体 selector 的 before/after 状态证明。
- [ ] 可见控制触达≥40×40；原生 checkbox 结合 label 扩大实际触达，报告内的小 control rect需结合 label人工确认。
- [ ] 可见文本≥12px、正文13/14px；对比度与颜色透明叠加人工审查，本脚本不声称测得完整 WCAG contrast。
- [ ] 各 Tab/Shift+Tab 焦点可见、有足够对比、不被 sticky 遮挡，SVG交互有名称和键盘等价；图形语义不能只靠颜色。
- [ ] 390px 无页面横向溢出、裁剪主动作、假隐藏；允许的内部横向泳道有可发现滚动与完整键盘访问。
- [ ] 减动画下 normal 与 ::before/::after 长时 animation/transition/smooth scroll停止或缩短；截图不是动效行为的唯一证据。
- [ ] 深海蓝黑与清冷青；warm coral仅异常/受阻，不把健康或装饰渲染为告警。
- [ ] 候选 CSS 自命名 scope，变量在自有根内，keyframe名不碰宿主；禁止 global body/:root/* 与通用 button 等泄漏。
- [ ] 生产 shell打开/关闭、切去其他DSH页面、插件卸载后，宿主颜色、字体、滚动与focus均无污染。
- [ ] 控制台error、pageerror、资源404、网络失败逐条解释；不预先白名单第三方错误以制造绿灯。
- [ ] 主线程独立执行 Instabox typecheck/test/build、已有app/sidebar/overlay回归与产物体积；本脚本不替代这些门禁。
- [ ] 比选记录写入实际 screenshot/report路径，区分观察、已修、待验和局限；选择最佳方案后才进入上线流程。

## 同数据比选记录（待真实截图）

| 候选 | 信息层级/密度 | 任务定位与操作 | 390px | 数据真实性 | 焦点/字号/触达 | 结论与截图 |
| --- | --- | --- | --- | --- | --- | --- |
| 鲸群航图 atlas | 待审 | 待审 | 待审 | 待审 | 待审 | 未运行 |
| 深海舰桥 bridge | 待审 | 待审 | 待审 | 待审 | 待审 | 未运行 |
| 洋流矩阵 current | 待审 | 待审 | 待审 | 待审 | 待审 | 未运行 |

最终状态：本文件交付检查方法与初读风险，不代表三版已跑通、不代表完成视觉比选、不代表生产发布。
