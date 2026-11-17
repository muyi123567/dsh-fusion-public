# 原生鲸面板独立验收

状态：仅完成验收脚本，未运行测试。父路统一在 Instabox 对整合提交执行。

宿主依据：deepseek-harness 39163dd，packages/client/ui-sidebar-right/src/client/shell/SidebarRight.tsx。
实际 DOM 使用 data-sidebar-right-session、data-sidebar-right-panel=push/fullscreen、
data-sidebar-right-open。正文经 sidebar.right.pane.tab keyed slot；不可猜测全局注册 API。

## 最小 smoke
使用已安装 playwright-core 的 Instabox 工作目录执行 node tests/whale-native-panel-qa.mjs。
临时环境提供 WHALE_NATIVE_URL、WHALE_NATIVE_COOKIE（Cookie header，不是 Set-Cookie）、
CHROMIUM_PATH、WHALE_EVIDENCE_DIR、WHALE_NATIVE_ADAPTER（绝对路径 ESM）。
不打印或持久化 Cookie，不保存 storageState、HAR 或 trace。

适配模块 default 对象必须提供 prepareEmptySession(page)、openPanel(page)、closePanel(page)、
composer(page)、chat(page)、panel(page)。后三者返回精确 Playwright Locator。
prepareEmptySession 可点击实际 preview welcome 的继续按钮，并创建/选择专用空 Session，
不得发送模型消息。panel 必须定位插件正文，不能返回整个右栏。
父路从实际 rc3 页面读取入口、会话按钮和 composer 选择器；未知项明确补适配，不伪造宿主。
isModelOrTaskWrite(request) 可识别并阻止模型/任务写入；未提供时此防护未覆盖，
脚本自身仅 fill，不 press Enter、不 send。

最小断言：真实 state 成功响应、原生 push 祖先、无旧 overlay、无可见 dialog、
聊天/输入可见且非 inert、聊天输入不与右栏重叠、body/root 关键样式不被污染、
1536/1280 桌面截图、输入未发送、关闭后草稿保留且焦点可回、未处理错误。
必须使用干净专用 Session；截图可能有私人 UI，仅存私有证据目录。

## 完整验收适配与待项
可选函数缺失会在 acceptance.json.pending 明确记录，最小 smoke 不代表完整验收。
- assertRealEmptyState：不拦截真实 state；断言实际空任务/来源状态，失败与合法空不可混淆。
- resizePanel：拖动宿主真实分隔条到 384 和 560；脚本核对宽度，不能 CSS 强制伪装。
- verifyDetails：任务、主机、团队、证据、返回和 Escape；可仅拦截
  /plugins/dsh-fusion/state，使用与生产结构相符并标注“合成”的 fixture；
  外部 API 一律不模拟，不触发写操作。先完成真实空态，再启用 fixture。
- verifyThemes：通过宿主设置切换明暗与字号；若用真实 body theme fixture，
  截图/记录明确标注 native-body-theme-fixture，不能声称设置链路已验收。
- verifyOceanLifecycle：进入海域前记录 chunk/模型请求为零；进入后有真实加载，
  切回任务/关闭后用实际动画调度或 GPU 生命周期证据证明停止，不能仅检查隐藏。
- verifyUnload：真实关闭 tab/unload 后确认监听器/渲染循环清理；不得仅以无错误代替。
- 聊天滚动需父路在有安全历史的 Session 额外验证；空 Session 无滚动内容不算通过。

每个 adapter verify 函数必须内部执行失败即抛出的断言；不得空实现。
验收记录保存精确整合 hash、宿主版本、命令退出码与 pending 清单。
本脚本不安装依赖，不改生产代码，不 push，不修改用户实际 profile。

## 临时登录入口与最小 firstpass（补充）
WHALE_NATIVE_LOGIN_URL 可替代 COOKIE/URL，直接 goto 后等待同源跳转并移除 token。
临时 URL 只放环境变量；导航失败转换为固定错误，不输出原始 Playwright 导航错误。
不截图浏览器地址栏，不保存 URL。截图只在登录跳转完成后进行。

WHALE_NATIVE_FIRSTPASS=1 可免 adapter：点击可见“继续”（如有），
点击最后一个“新建会话”，可用 WHALE_NATIVE_WORKSPACE_NAME 指定真实工作区显示名称，
点击精确名称“鲸”的按钮（实际名称不同用 WHALE_NATIVE_OPEN_BUTTON）。
这些是实际可见按钮动作，不调宿主私有 API。页面若还有其他选择步骤，提供 adapter。
父路必须先修正 runtime cwd 为可访问目录，不通过假 API 造默认工作区。

firstpass 只证明真实 push 右栏内出现任务/主机/团队/海域，且无 overlay/dialog；
不证明 composer、空态、resize、主题或生命周期通过。证据 mode=firstpass。
完整验收仍需 adapter。未执行测试。
