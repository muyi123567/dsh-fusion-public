# 第三版任务优先：设计自审

final result: passed

## 快速展示增量：2026-11-20

用户基本认可静态方向后，要求增加动画用于前端快速展示。本轮在独立交互稿增加显式启动的一次性导览，
不替换production入口、不改变fixture或来源状态、不请求真实任务。

- 节奏：列表 → 待验收详情 → 当前缺口 → 来源证据 → 明确结束；每阶段约3秒，总计约15秒。
- 动效：列表分组短暂依次进入、详情轻微淡入、缺口/证据短暂描边；不循环，不播放任务成功或远端执行动画。
- 控制：开始、暂停、继续、重播、退出；任务/聊天区域内用户操作立即退出。页面隐藏保留剩余时间，重新可见后继续。
- 可访问性：保持同一个主控制按钮DOM与键盘焦点；减少动态效果时不自动计时或位移，使用手动“下一步”。
- source visual reference：本报告下文的r4静态稿。实际图：`tour-r4-01-list.png`、`tour-r4-03-gap.png`、
  `tour-r4-05-ending.png`；窄栏`tour-420-final-pane.png`、`tour-560-dark-ending-pane.png`；
  减动态`tour-r4-reduced-motion.png`。视口1440×1000、deviceScaleFactor 1；面板420/560×807 CSS px、图片高度808px。
- 实际浏览器采样84帧，五阶段均出现。`whale-task-first-motion-preview.gif`为一次播放的短预览，
  约17.5秒（含结尾停留），420×846像素；顶部38px是录屏外的合成展示说明，下面是未重绘的真实面板截图。
  GIF不宣称固定帧率或视频级流畅度。

### 动效迭代发现与修复

1. **列表启动位置错误，已修。** 已滚动列表启动时目标任务不在首屏；补回归先复现scrollTop仍为240，再修复为顶部0。
2. **键盘启动丢失焦点，已修。** 原按钮被条件分支替换导致焦点落到body；改为稳定DOM按钮，自动步骤不转移焦点。
3. **可见证据仍被滚动，已修。** 宽版证据已完整可读时不再自动滚动，避免任务标题半截裁切；TaskStudy唯一负责导览滚动。
4. **工具栏横跳，已修。** 首次视觉复审blocked：结束长句挤动整组控件约160px；固定控制组与状态槽后重抓，
   情境、主题、主控制按钮从空闲到结束的x/y位移均实测0px。

本轮源码复核`motion_review`与视觉复核`design_critical_review`均已收束，无遗留P0/P1/P2。
视觉复核依据关键帧与开始/结束对照，不据此承诺连续播放帧率。
原横跳图保留为`tour-toolbar-before-fix-{start,ending}.png`，修后图仍为上述`tour-r4-*`。

### 动效新鲜验证

- 新增6项导览回归，与原8项TaskStudy回归合计14 passed（2文件），exit0；client build含类型检查，exit0。
  起初4项因功能缺失失败；后来2项因滚动/焦点问题失败。保留工具原始运行记录，不把中间失败写成全绿。
- 13组既有浏览器检查通过；另6组导览检查通过（含工具栏不跳、焦点、暂停/继续、减少动态效果）。
- 实际采样另覆盖420浅色与560深色结束态，无面板横溢出；浏览器page/console errors和写请求均为0。
- 最新构建/测试日志：`/data/openlet/logs/dsh-fusion-design-20261120-tour-accepted/`。
- 行为回执：证据目录`tour-r4-browser-qa.json`、`tour-interaction-qa.json`、`tour-motion-timeline.json`。
- 当前源文件和演示产物hash见`tour-source-and-evidence-manifest.json`；下文r4 manifest仍只对应先前静态快照。

后续仍须将经过选择的表现映射到DSH原生tokens和真实入口；本轮动画不是多机执行或独立业务验收证据。

范围：独立 `design-study.html` 的任务列表、详情与来源证据阅读。用户已基本认可静态方向，动画增量已完成内部审查；
这不等于用户的最终整体验收，也不表示production native 入口已经替换，或真实双 Host 执行、版本回执及独立 Review 已交付。

## 依据与比较边界

- 用户选定第三版任务优先结构，同时否决旧稿美感，要求先设计并自审。
- 依据：`docs/design/2026-11-20-task-first-design-brief.md`；保留原生右栏正文边界与宿主聊天。
- 方向：航次日志；暖白、墨色、少量海色，通过字阶、对齐、留白组织任务和证据。
- source visual truth path（内部方向参考）：
  `/data/openlet/evidence/dsh-fusion-design-20261120-r2/r3-wide-light-list-pane.png`、`r3-420-light-detail-pane.png`。
  这是已渲染的内部候选，不是用户认可的独立 Figma/图片设计真值。
- implementation screenshot path：同目录 `r4-wide-light-list-pane.png`、`r4-420-light-detail-pane.png`。
- 本轮是基于 brief 的重设计与拒绝后迭代，不宣称对外部设计稿的像素保真。
  r3 对 r2 的有意修改：元数据中文化、证据标题下收6px、失败详情明确旧快照与当前性未知；
  r4 对 r3 仅加深三项浅色文字token，修正选中/证据底上的对比，不改布局、内容、字号或深色覆写。
  任意证据原文不作通用状态词替换。

## 环境与证据

证据目录：`/data/openlet/evidence/dsh-fusion-design-20261120-r2`。
目录沿用项目 Asia/Shanghai 日期，实际UTC时间见manifest。
浏览器视口1440×1000 CSS px，deviceScaleFactor 1；面板原图不缩放。
面板起点y=139.5px，元素截图向外取整：常规CSS高度807px、图片808px；这是裁切边界取整而非密度差异。

| 状态 | CSS尺寸 / 原图像素 | 最终截图 |
| --- | --- | --- |
| 宽浅色/深色并排列表与详情 | 850×807 / 850×808 | `r4-wide-{light,dark}-list-pane.png`，另有对应`-full.png`整窗 |
| 浅色列表/详情 | 420×807 / 420×808 | `r4-420-light-{list,detail}-pane.png` |
| 浅色详情 | 560×807 / 560×808 | `r4-560-light-detail-pane.png` |
| 深色详情 | 420×807 / 420×808 | `r4-420-dark-detail-pane.png` |
| 长标题、未知负责人、陈旧、失败、未配置、合法空集 | 420×807 / 420×808 | `r4-420-light-{long,unknown,stale,unavailable,not-configured,empty}-pane.png` |
| 任务移除、证据滚动/原文 | 420×807 / 420×808 | `r4-420-light-{missing,evidence-scrolled,evidence-raw}-pane.png` |
| 低高度、已滚动证据 | 420×418 / 420×419 | `r4-420-low-height-pane.png`；外层分配420px含边框 |

- full-view comparison evidence：`r3-r4-wide-comparison.png`，两个850×808原图面板同屏；另保留r2-r3比较。
- focused region comparison evidence：`r3-r4-detail-comparison.png`，两个420×808原图详情同屏。
- 拒绝记录对照：`r1-r2-420-light-{detail,list}-comparison.png`。
- 最终画板：`r4-narrow-design-board.png`，仅拼接三张1×截图，未重绘界面。
- 字阶检查：`r4-grayscale-hierarchy.png`，灰度及0.65px轻度模糊后主次仍可辨；该处理图不代替正常色彩图审。
- 内置窗口探测返回`The browser access host is unavailable`且无browser surface；沿用本任务已采用的本机Playwright/Chromium ARM64。
  未安装新依赖，预览仅监听loopback，外围宿主与审稿控制明确标为示意。

## 迭代历史

| 轮次 | 实际问题 | 修复及证据 |
| --- | --- | --- |
| r1：blocked | 长正文把实质证据挤至约775px；缺口与普通属性同权；证据是pre文本盒 | r2证据前置、正文折叠；缺口与计数分层；结构化阅读与精确原文并存 |
| r1：blocked | 各组标题同权、归属占高、外围聊天抢重心 | r2按优先级区分字重、归属压紧、聊天示意减半；重新看宽浅/深及100%窄栏 |
| r1：blocked | claimed/cancelled/终态与阻塞混淆；verifying被推断只缺Review | r2来源原状态与依赖事实分别呈现；证据要求标未核验，不按条目数推断齐备或通过 |
| r1：blocked | 任务消失静默换记录；来源/返回丢失；IME Escape被导航抢走 | r2保持身份与missing状态、sticky来源/返回、编辑/组合输入保护与焦点回退 |
| r2：精修 | 元数据开发字段感；证据标题下略松；失败详情只写来源不可用 | r3中文元数据、margin14→8px、明确保留09:15旧快照且当前状态未确认 |
| r3：静态通过后补测阻断 | 视觉/语义复审已过；进一步量化发现浅色muted在选中底4.09:1、海色4.15:1，低于普通小字4.5:1门槛 | 保留r3静态审查记录，但不拿它覆盖新增的实际对比发现 |
| r4：passed | 浅色muted/sea/warning分别调整为606D74/14767D/866626 | 48组文字token与阅读底色对比最小4.592:1；13组浏览器检查、8项回归与build通过，独立复看浅色层级未退化 |

时间戳继续降权的建议，经视觉审查者最终复查后撤回：重复感不构成用户问题，进一步减字号/对比可能伤可读性。
原文中的`verifying`保留，以免美化阅读时改写来源内容。

## 五个必查视觉面

| 项目 | 最终判断与边界 |
| --- | --- |
| 字体与字阶 | 本机中文Noto Sans CJK SC、正常字距；任务15px、详情24px、证据14px、辅助12–13px。100%窄栏及长标题/ID已看图；live须继承宿主字体。 |
| 间距与版面 | 首任务距面板顶126px；常规420详情实质证据区起点492.8px。420/560单栏往返，容器799/800实测切换，宽列表300px。 |
| 颜色与tokens | 浅暖白/墨色，深中性炭黑；少量海色；风险有文字与图标。量测48组文字/阅读底色组合最小4.592:1；正式迁移映射`--dsw-*`，不导入独立稿全局reset。 |
| 图像与素材 | 无装饰图片、Logo重绘或海景；使用已安装Lucide状态/类型图标，未用假图案或大阴影补“设计感”。 |
| 文案与事实 | 演示/全局明确；原状态与阻塞分开；证据原文完整、要求未核验；完成回报、证据存在、独立验收不混为一谈。 |

## 流程验收

1. **进入列表：通过。** 页面身份正确、非空、无框架错误层；首条任务126px。
2. **搜索筛选：通过。** 无匹配有明确空态，清除恢复7项；需关注筛选返回3项。
3. **打开详情：通过。** 焦点进入标题；来源原状态、缺口、范围与证据要求分开。
4. **阅读证据：通过。** 滚动后返回仍可见；阅读版/原文、方向键/Home/End页签、正文展开可用。
5. **返回与移除：通过。** Escape返回原行并隔离宿主；IME/编辑/已处理事件不抢导航；原任务消失不换身份，返回回退搜索框。
6. **来源异常：通过。** 陈旧、失败保留旧快照、未配置、合法空集分别呈现；演示重读仅切换本地fixture。
7. **容器与低高度：通过。** 同一视口改变799/800px容器验证布局；切420保留任务/聊天草稿，低高度仍可读证据和返回。

`r4-interaction-qa.json`：13组通过（新增实际token对比量测），page errors 0、console errors 0、write requests 0。
不据此宣称完整无障碍符合性；屏幕阅读器、真实宿主事件及所有平台字体未测。

## 新鲜验证与独立审查

- `pnpm --filter @dsh-fusion/client test src/features/design-study/TaskStudy.test.tsx --maxWorkers=1`：1文件、8 passed，exit0。
  新增回归没有RED阶段，不作RED→GREEN声明。
- `pnpm --filter @dsh-fusion/client build`：exit0，包含TypeScript与Vite；仍有既有scene chunk大于500kB警告，未借此宣称产品性能问题已解决。
- 原始日志和独立exit文件：`/data/openlet/logs/dsh-fusion-design-20261120-r4/`。
- 捕获/行为脚本：`/data/openlet/cache/dsh-fusion-runtime-20261120/capture-study-r2.py r4`、`verify-study-design.py r4`。
- 精确源码、脚本与截图hash：证据目录`r4-source-and-evidence-manifest.json`。
- `design_critical_review`：r1否决；r3六图重新检查后通过；r4两张浅色新图局部复看无P0/P1/P2回退。
- `native_design_constraints`：r1语义阻断已修；r3失败快照与中文metadata复核通过；r4仅CSS修订确认无语义回退。
- `fusion_final_review`：稳定r2身份、来源、证据、状态与Escape源码复核无阻断；不替代看图或运行。

## 后续边界

本阶段止于设计送审。真实DSH主题/停靠/关闭恢复、主机/团队/海域及扩展完整保留、双Host执行、
绑定版本和产物的Receipt、独立Review及恢复失败矩阵分别验收。
后续最小执行链和八项门禁已追加到`docs/design/2026-11-20-collaboration-control-plane.md`，明确标未实现。
当前改动未提交、推送、公开发布或安装进production。
