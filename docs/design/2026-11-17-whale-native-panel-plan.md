# 鲸原生停靠面板改版方案
日期2026-11-17。用户截图审查：大标题/口号、KPI横条、3个鲸卡、海蓝自定义色板，以及全屏overlay与第二套sidebar，呈网站后台布局。用户明确要求面板形式，不覆盖DSH原生页面；先充分规划再五路实现。

## 原生依据
研究上游deepseek-ai/deepseek-harness固定39163dd30f703a79079e2d2446545cff3c453738；研究副本/tmp/whale-dsh-native-research-20261117/source。
ui-sidebar-right README及实际0.2.2-rc.3类型均确认sidebarRightTabs.register与sidebar.right.pane.tab keyed正文、ctx.sidebarRight.openTab。
文件插件ui-sidebar-files通过相同接口接入；普通push模式给会话让出空间，标签、关闭、分栏与宽度由宿主管理。
docs/web-styling.zh.md：功能使用--dsw-alias-*语义token、不自建全局主题；字号行高配对、共享字体、发丝线、角色一致控件。
既有beta13安装包与公开preview不是本轮原生效果的验收证据，必须在实际测试DSH里打开新包。

## 产品结构与默认行为
1. 从DSH侧栏“鲸”入口或原生右栏添加页打开kind dsh-fusion.panel；复用标签去重，不新增顶级网页壳，不注册shell.overlay，不自动切换DSH中央页。
2. 面板内只一条紧凑工具栏：刷新、当前来源/陈旧提示；紧凑页签“任务 / 主机 / 团队 / 海域”。默认任务，把受阻、失败、待验收置前，保留明确状态及证据，不设大号总数或营销标题。
3. 主列表按行扫描：标题、所属团队/主机、状态、证据。点击行在同面板进详情，顶部返回；Esc仅处理内部详情/临时菜单，不抢走DSH全局键位，不focus-trap。
4. 详情重点是当前状态、执行目标、依赖、日志/产物证据；有真实命令API才显示写操作，不能造“立即修复”。SSH可达与PTY连接区分。来源缺失、空、陈旧分别呈现。
5. 鲸意象保留在可选海域页：300~420px容器视野，原生小工具栏与团队选择，移除网页级顶部/底部栏、情境演示按钮及全屏口号；数据语义沿用现有life-director，低性能/减动画边界保留。
6. 颜色/字体继承DSH明暗与字号。内容不定义主题选择器/全局body规则，不把全部背景染蓝。标准字14px，辅助12px，紧凑行44~56px，平面分隔用0.5px语义token；可交互控制有键盘名称与焦点。
7. 对没有对应原生面板服务的宿主，明确不可用，不回退覆盖层。没有当前Session时提示先选择会话；不自动建真实Session。
8. 用户“不能覆盖”在桌面push模式验收；DSH自带窄屏会自动全屏是宿主行为，插件不自行创建遮罩，必须说明与实测。

## 数据与实现契约
新features/native-panel目录。NativeWhalePanel({snapshotUrl?,sessionId?,visible?})拥有快照协调/刷新/选择/列表；production snapshotUrl=/plugins/dsh-fusion/state。
export NativePanelData: {model:WhalePanelModel; tasks:TaskRecord[]; nodes:NodeRecord[];teams:AgentTeamRecord[]; error?:string; loaded:boolean}。
export NativePanelSelection:{kind:"task"|"host"|"team";id:string}。
详情NativePanelDetails({selection,data,onBack,onSelect})；主题与容器由native-panel.module.css持有。
海域NativeOcean({model,visible,onSelectTeam})，懒加载，只挂载海域页时使用。不得由其他页加载Three。
原生client.workspace.tsx改为新面板entry可保持export FusionWorkspace兼容loader；传入sessionId/visible来自useTabInfo和slot runtimeprops。
旧站点与功能不删，以候选入口替换，不重写已有历史，不安装用户本机profile。

## 五路与写集
A原生接入：packages/plugin/src/client.tsx/client.workspace.tsx/client.workspace-loader.ts、package.json dsh.client.inject、对应native契约测试。只注册native tab/入口；scope/dispose/loading/error/缺能力。
B面板架构与样式：features/native-panel/NativeWhalePanel.tsx、native-panel.module.css、use-native-data.ts。使用公共types.ts；列表/页签/搜索/刷新浪涌/明暗响应。
C详情与操作：features/native-panel/NativePanelDetails.tsx、native-details.module.css；对应详情测试。
D意象适配：features/native-panel/NativeOcean.tsx、native-ocean.module.css；已有ambient/lifecycle按需补visible生命周期，但不修改B/C。
E独立验收：tests/whale-native-panel-qa.mjs、docs/design/2026-11-17-native-panel-acceptance.md。真实DSH原生侧栏、会话可输入/滚动、关闭恢复、resize/tab切换、明暗与字号、任务详情、空/陈旧/离屏无3D。

## 顺序与验收
先保存研究与方案，再分配五路隔离CUE worktree。父线解决依赖/整合/小接口冲突，统一Instabox冻结安装/类型/测试/包构建/doctor。
必须实际DSH 0.2.2-rc.3中打开此插件面板，在原生聊天可见情况下截取整窗；对照主题tokens与原生文件/终端界面，而不是独立静态站点。
截图审查桌面1536、1280和窄面板384；固定宿主无全屏overlay；通过后提交推送，先不更改用户实际production profile。
