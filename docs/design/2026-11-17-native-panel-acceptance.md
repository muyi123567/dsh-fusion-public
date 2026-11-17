# 鲸原生面板独立验收

2026-11-17。最终发布候选 3a317257…85139ee26 的来源、原生入口、公开 extension 与明确 DEMO 预览通过；性能 14 passed / 0 failed / 3 pending，总状态 incomplete。父负责最终 runtime，E 只读签核；R3 与此前候选记录分别保留为历史。未改生产 profile，未发送模型消息。


## 最终发布候选签核

当前签核唯一包为 `dsh-fusion-0.2.0-beta.14`，SHA-256：

`3a317257ceb5e4f77b756c9e72a63530e56e73146109ecd5613163385139ee26`

父在官方 `dsh plugin add` 更新退出 0 后串行执行三次 runtime。父回传三次 QA_EXIT 0、DSH_STOPPED True；E 未再占用浏览器，只读核对原始 JSON、实际 tgz、已装文件及已保存的 HTTP 响应体。

| 证据层 | 最终包结论 | 实际范围 |
| --- | --- | --- |
| source/extension | passed | 四 chunk 与 tgz 逐字节相同；真实来源“未配置”提示；420px 原生 push 与聊天/输入共存；公开 API 1.1 实际注册渲染 6 task / 3 node / topology，dispatch/cancel 回调缺席 |
| 明确 DEMO 预览 | passed | 真实 DSH 宿主内的 420px 任务、海域整窗图；只用明确 demo:true 快照，不能当真实任务执行 |
| 性能与生命周期 | **incomplete：14 passed / 0 failed / 3 pending** | 5 项 source/artifact 契约与 9 项真实浏览器检查通过；不写“整体性能全通过” |
| R3 设置/局部导航历史 | 保留先前实测 | 原生明暗/会话字号、task→host/team→back/Escape 焦点、384/420/560 及 1536/1280 矩阵绑定 R3 原包，未在最终包全部重跑 |

最终包性能已实际通过：默认不加载海域 chunk、减动画/still 不创建 WebGL、真实 GL draw 增长、暂停停止提交、任务页卸载与 context lost、原生右栏隐藏停止并释放、动态转 still 释放、任务页往返保留海面/质量/暂停/团队分页，以及 served 执行代码与候选绑定。原生关闭重开按已确认契约回到任务页；这不构成跨整个面板卸载的偏好保留承诺。

三项性能 pending 原样保留：

- 真实非 DEMO 团队详情与返回：合成团队按钮有意禁用，没有伪造真实团队条件。
- 物理 GPU 利用率、功耗、VRAM 回收：GL draw/context lost 仅证明浏览器软件生命周期。
- 整个原生 tab 移除与真实 OS 后台化：本次仅覆盖右栏隐藏及 Habitat 子场景卸载。

source、performance runtime、previews 的模型/任务写入观察计数与页面异常均为 0；source/performance 另记录 consoleErrors=0。真实任务在合成拦截前后均为 0。请求计数不替代服务端全账本审计。

E 独立读取 publish-candidate 原 tgz 并比较当前已装四文件：全部字节相同，无 node_modules 手工改动。三个已保存服务响应都含完整的候选字节前缀；剩余内容逐字节限定为实际 rc3 的 `semicolon/newline + sourceMappingURL` trailer，未通过忽略任意执行代码差异来判相同。

| 报告 | SHA-256 |
| --- | --- |
| ui-qa-publish-source/report.json | 6a5a8c5f8590864f1d1a11cf84d230a9aa9fed86e1f916cd8722438d8ee8b34b |
| ui-qa-publish-performance/performance/report.json | cea9381c223abfb12321a10a7d4edf00d3276637d22c3091da5cc58a45fcd80d |
| ui-qa-publish-performance/runtime-report.json | 0792f8c2d396649e766664b20fd3ada1df4cc872a629225c33a624cebcd9ff5d |
| ui-qa-publish-previews/report.json | 137f3b3a1e4ff9bf87690dab75bc7fa51aeb39432eb0a936244e8d3bcf1c97bf |

| 当前明确 DEMO 420px 图 | 字节数 | SHA-256 |
| --- | ---: | --- |
| DEMO-native-ocean-420.png | 168543 | 12d5111a717ca6bc7db61d818f8a399c3ae5048e1d42cc9d332bccdff68acf03 |
| DEMO-native-tasks-420.png | 95066 | f2011e13f25f9129d4f33ab25365cb238f68ea0dbdcbe126c8a36e2a00ccb4f4 |

证据保留在授权私有目录 `/tmp/whale-native-20261117/ui-qa-publish-*`；公开副本由父发布方归档。此前 8447 候选（完整哈希见历史节）及其失败/通过轮次只属历史；不再当作当前发布包验收。

## 当前公共 runtime 概要

下列机器摘要不包含 endpoint、临时登录 URL、Cookie、profile 路径或真实业务正文，可供公开发布说明引用。运行进程退出/停止是父回传执行记录，JSON 结果与字节绑定是 E 本轮只读核验。性能总状态明确为 incomplete。

~~~json
{
  "schemaVersion": 2,
  "package": {
    "name": "dsh-fusion",
    "version": "0.2.0-beta.14",
    "sha256": "3a317257ceb5e4f77b756c9e72a63530e56e73146109ecd5613163385139ee26"
  },
  "conclusion": {
    "sourceAndPublicExtension": "passed",
    "explicitDemoPreviews": "passed",
    "performance": "incomplete",
    "performanceCounts": {
      "passed": 14,
      "failed": 0,
      "pending": 3
    },
    "overallPerformancePassed": false,
    "note": "Passing software lifecycle checks do not establish real-team navigation, hardware GPU/energy/VRAM, or full native-tab/OS-background behavior."
  },
  "runtime": {
    "host": "DSH",
    "hostVersion": "0.2.2-rc.3",
    "nodeVersion": "24.19.0",
    "isolatedProfile": true,
    "officialPluginAddExit": 0,
    "qaExits": {
      "source": 0,
      "performance": 0,
      "previews": 0
    },
    "allDshProcessesStopped": true,
    "executionProvenance": "Official update and process exit/stop receipts reported by parent; E independently read reports and compared tarball/installed/served bytes."
  },
  "installedChunks": [
    {
      "name": "client.js",
      "bytes": 3549,
      "sha256": "15971a4ff25e4f0785b4cd1a1a30e1104a7c6a3d31e14e6d82d1141b282342a3",
      "exactBytesEqual": true
    },
    {
      "name": "client.workspace.js",
      "bytes": 32625,
      "sha256": "3acf6a6ae3fc554ba8272d16b931dc2b9ce6aac1d1107e4c0cd69ef23ba45ca4",
      "exactBytesEqual": true
    },
    {
      "name": "client.native-ocean.js",
      "bytes": 148168,
      "sha256": "8fee9848fd0abb4755d3376deda51855045ca2077d9dfb471143679452d26447",
      "exactBytesEqual": true
    },
    {
      "name": "client.ocean-scene.js",
      "bytes": 1891630,
      "sha256": "81ef1f285d85f5df7847f06ba23fd597870b02856cf7a581d6fab6fd5a87b1a6",
      "exactBytesEqual": true
    }
  ],
  "installedFilesModified": false,
  "sourceAndExtension": {
    "status": "passed",
    "input": "real state checked before/after explicit demo:true extension fixture; only same-origin exact state GET intercepted",
    "realSnapshotDemo": false,
    "nodesSource": "unavailable",
    "visibleNotice": "主机来源未配置，暂不能确认当前记录。",
    "nativePushWidthPx": 420,
    "chatComposerVisible": true,
    "pluginOverlay": false,
    "publicApi": {
      "ready": true,
      "version": 1,
      "api": {
        "major": 1,
        "minor": 1
      },
      "register": true,
      "list": true
    },
    "extension": {
      "input": "explicit demo:true; only same-origin exact state GET intercepted",
      "generations": [
        1
      ],
      "taskCount": 6,
      "nodeCount": 3,
      "topologyVersion": 1,
      "dispatchAvailable": false,
      "cancelAvailable": false,
      "readiness": [
        true
      ]
    },
    "realTasksBefore": 0,
    "realTasksAfter": 0,
    "observedModelTaskWriteAttempts": 0,
    "pageErrors": 0,
    "consoleErrors": 0,
    "reportSha256": "6a5a8c5f8590864f1d1a11cf84d230a9aa9fed86e1f916cd8722438d8ee8b34b"
  },
  "performance": {
    "status": "incomplete",
    "counts": {
      "passed": 14,
      "failed": 0,
      "pending": 3
    },
    "passedByLayer": {
      "sourceAndArtifactContracts": 5,
      "browserRuntime": 9
    },
    "finishedAt": "2026-11-17T05:41:12.838Z",
    "input": "explicit synthetic DEMO state response; compiled product chunks unchanged",
    "browserChecks": [
      {
        "name": "default tasks/hosts/teams never request ocean or Three chunks",
        "status": "passed"
      },
      {
        "name": "first reduced-motion entry and explicit still create no WebGL",
        "status": "passed"
      },
      {
        "name": "balanced mode advances real WebGL draws",
        "status": "passed"
      },
      {
        "name": "pause stops actual submissions",
        "status": "passed"
      },
      {
        "name": "task tab unmounts habitat and releases real context",
        "status": "passed"
      },
      {
        "name": "native rightbar hide stops submissions",
        "status": "passed"
      },
      {
        "name": "dynamic to still releases context without creating another",
        "status": "passed"
      },
      {
        "name": "preferences survive task-tab return",
        "status": "passed"
      },
      {
        "name": "real team detail/back preserves preferences and identity",
        "status": "pending",
        "reason": "No selectable real team; DEMO buttons intentionally disabled, never falsify demo flag"
      },
      {
        "name": "served compiled chunks match candidate bytes",
        "status": "passed"
      },
      {
        "name": "physical GPU utilization, energy and VRAM reclamation",
        "status": "pending",
        "reason": "No OS/GPU profiler data; GL draws and context-lost events do not measure these."
      },
      {
        "name": "full native tab removal and real OS backgrounding",
        "status": "pending",
        "reason": "Only native rightbar hide and habitat unmount exercised; no guessed close-tab API or forged document.hidden."
      }
    ],
    "observedModelTaskWriteAttempts": 0,
    "pageErrors": 0,
    "consoleErrors": 0,
    "realTasksBefore": 0,
    "realTasksAfter": 0,
    "reportSha256": "cea9381c223abfb12321a10a7d4edf00d3276637d22c3091da5cc58a45fcd80d",
    "runtimeReportSha256": "0792f8c2d396649e766664b20fd3ada1df4cc872a629225c33a624cebcd9ff5d"
  },
  "previews": {
    "status": "passed",
    "input": "explicit demo:true snapshot; real DSH host",
    "writes": 0,
    "pageErrors": 0,
    "reportSha256": "137f3b3a1e4ff9bf87690dab75bc7fa51aeb39432eb0a936244e8d3bcf1c97bf",
    "images": [
      {
        "name": "DEMO-native-ocean-420.png",
        "bytes": 168543,
        "sha256": "12d5111a717ca6bc7db61d818f8a399c3ae5048e1d42cc9d332bccdff68acf03"
      },
      {
        "name": "DEMO-native-tasks-420.png",
        "bytes": 95066,
        "sha256": "f2011e13f25f9129d4f33ab25365cb238f68ea0dbdcbe126c8a36e2a00ccb4f4"
      }
    ],
    "servedCodeBinding": "Each served chunk begins with the complete exact candidate bytes; the remaining suffix is only the verified rc3 semicolon/newline and sourceMappingURL comment."
  },
  "historicalEvidence": {
    "r3": {
      "sha256": "440e65daf591f3346c9906410a1756a837b407f8a2281f50b4e06c69711fa0da",
      "scope": [
        "native settings light/dark",
        "conversation content font 14 to 15 and restore",
        "task/host/team navigation and focus returns",
        "1536/1280 viewports and native panel 384/420/560 widths"
      ],
      "rerunOnPublishCandidate": false
    },
    "previousCandidate": {
      "sha256": "844749d046223580c1e7e82c1f5c4e2de6473cf3524c851b5162fa3054c42ca6",
      "status": "historical; superseded by the package sha256 in this receipt"
    }
  },
  "outsideThisReceipt": [
    "chat history scrolling with populated safe Session",
    "native settings persistence across runtime restart"
  ]
}
~~~

## R3 基础验收与证据

候选包 SHA-256：`440e65daf591f3346c9906410a1756a837b407f8a2281f50b4e06c69711fa0da`。

首次 R3 运行的进程记录为 `QA_EXIT 0`、`DSH_STOPPED True`。其证据目录是 `/tmp/whale-native-20261117/ui-qa-r3/`。后续仅补原生设置、精确详情返回及会话关联，未重跑全部宽度与海域截图；记录同样为 `QA_EXIT 0`、`DSH_STOPPED True`，证据在 `/tmp/whale-native-20261117/ui-qa-r3-followup/`。

| 实际检查 | 结果与范围 | 证据 |
| --- | --- | --- |
| 原生新会话与工作区 | 通过 DSH 按钮创建空会话，选择可访问目录；不调用虚构 Session API | 两轮 report.json |
| footer 入口 | R3 的“打开鲸面板”进入真实 push 右栏；无插件 overlay、无可见 dialog | real-empty-1536.png |
| 聊天与会话关联 | 实际安装 rc3 的 data-conversation-region=chat 可见且未 inert；其 session 与原生右栏 session 相同 | followup/report.json |
| 桌面与原生宽度 | 实际拖动宿主分隔条到 384、420、560；1536 与 1280 视口 | native-width-*.png、native-1280.png |
| 有数据窄栏 | 明确 demo:true 合成快照；不冒充真实业务数据 | DEMO-width-384.png、DEMO-width-420.png |
| 详情与局部返回 | task→host→back、task→team→back 的 ID 均核对；只在原生 panel 正文内导航 | followup/DEMO-task-host.png、DEMO-details.png |
| Escape 与列表返回 | 详情 region 消失，并核对原任务行获得 document.activeElement；不以旧“返回任务”按钮 count=0 推定通过 | followup/report.json 的 details |
| 证据展示 | 核对明确合成 artifact 文本、href 和新窗口属性；没有访问证据 URL | followup/DEMO-evidence.png |
| 原生主题设置 | 实际“账号菜单→设置→通用设置”切浅色/深色；关闭、重开设置后检查选中状态 | native-settings-light/dark-dialog.png、native-settings-light/dark.png |
| 原生字号设置 | 明确为“仅影响会话内容”的设置：14→15，composer 14px→15px，面板控件保持 14px；随后用原生控件恢复 | native-settings-content-font-size.png、followup/report.json |
| 关闭与重开 | 同一原生 tab/session；未发送草稿保留，composer 可重新聚焦；测试结束清空草稿 | followup/report.json |
| 写入与异常 | 浏览器 HTTP 路由观察的模型/任务写入尝试为 0；前后真实 tasks 数组均为空；没有 pageerror/console error | followup/report.json |
| 来源语义 | 最终 fresh 候选已实测明确“主机来源未配置”，没有把 nodes=[] 称为合法空板 | final-parent/report.json，见最终 receipt |
| 海域 | R3 已有合成场景截图；图像不能证明停帧或释放。性能模块由 D 提供，E 单独接线执行 | 性能报告另列 |

followup 中的 `diagnostic-settings-trigger-before-adapter-fix.png` 是初次适配设置入口失败的留证，不是最终运行失败。最终结果以 report.json 与 manifest.json 为准。

主题不再仅依赖 body token fixture。旧 R3 的 `native-body-theme-fixture-*.png` 仍准确标为 token fixture，不用于证明用户设置流程。字号控件明确只影响会话内容，因此不要求原生导航跟着会话字号放大；已经实测并记录两者的实际尺寸。设置跨 runtime 重启的持久性未验证。

## 正式脚本

`tests/whale-native-r3-smoke.mjs` 使用具体 rc3 adapter，输出紧凑 JSON；不输出整页正文或按钮清单。

必须通过环境提供：

- `WHALE_NATIVE_LOGIN_URL`：临时登录入口，只在内存使用；导航错误不输出敏感 URL。
- `CHROMIUM_PATH`、`WHALE_EVIDENCE_DIR`、`WHALE_QA_CWD`。
- `WHALE_QA_ISOLATED_PROFILE=1`，限定授权隔离 profile。
- `WHALE_QA_DEMO_SNAPSHOT`、`WHALE_QA_DEMO_TASK`：显式合成快照与精确任务名。
- 可选 `WHALE_NATIVE_OPEN_BUTTON`（默认“打开鲸面板”）、`WHALE_QA_ARTIFACT_SHA256`。
- `WHALE_QA_FOLLOWUP=1` 只补设置、详情返回与会话关联，复用已有宽度截图。
- 云容器需要时显式传 `WHALE_QA_NO_SANDBOX=1`；脚本不改变本机环境。

fixture 只匹配当前页面同 origin 且 pathname 精确为 `/plugins/dsh-fusion/state` 的路由。不模拟宿主壳、Session 服务或其他 API；完成后卸载路由、刷新真实来源，再读取真实任务数。HTTP 请求计数不等价于对服务端全部账本的独立审计。

`tests/whale-native-panel-qa.mjs` 仍保留 URL+Cookie 或 LOGIN_URL 的通用入口；默认加载实际 rc3 adapter。Cookie 不打印、不落盘，不保存 storageState/HAR/trace。真实 DOM 来自固定上游与实际安装 rc3：右栏 data-sidebar-right-panel/session/tab、ConversationContent 的 data-conversation-region/session；不猜 main 祖先，也不使用可能在详情页消失的“海域”文本定位 panel。

## 运行版本与证据完整性

增量设置/详情运行所用源码 SHA-256：

- whale-native-r3-smoke.mjs：`b33b7ab12b330f173cf5fe0905c705666f08e7e18f0b5dadfd5fa29b425cc386`。
- whale-native-rc3-adapter.mjs：`c7bacefc593a7ba31715a7b0a783262bbb5ddfeb33c0a7cdf5c174d8089334d4`。
- followup/report.json：`81d1f8a469a26b40090a076041b68d24c73b17e59042fc7581753e92324160ad`。

followup/manifest.json 记录候选哈希、以上 QA 源码哈希及各图片大小、SHA-256。截图仅留授权私有证据目录，不包含地址栏或登录 URL。

## 仍未验证

- 空 Session 没有安全的历史消息；聊天历史滚动不算通过。
- 原生整个 tab 移除/unload、真实 OS 后台化、物理 GPU/功耗/VRAM 不由截图推断。
- DEMO 海域团队按钮按产品约定禁用；不能改 demo 标记伪造真实团队详情通过。
- 合成数据列表与详情、真实空任务快照、真实来源提示分别取证；最终 source/extension 见当前发布候选签核。
- D 模块旧轮失败保留为历史；最终性能为 14 passed / 0 failed / 3 pending，总状态 incomplete，不能称整体性能全通过。

## R3 海域实测及独立隐藏定位

D 的 performance 模块通过 E 的独立 runner 实际执行，未重跑设置、全部宽度或详情矩阵。第一轮整体失败：10 passed / 4 failed / 3 pending，QA_EXIT 1、DSH_STOPPED True。证据：/tmp/whale-native-20261117/ui-qa-r3-performance/，其中 performance/report.json 为 D 分层报告，runtime-report.json 与 runtime-execution.log 为 E 的实际运行记录。

已经通过的浏览器检查是默认任务/主机/团队不加载海域 chunk、首次减动画与 still 不创建 WebGL、balanced 有真实 GL draw 增长、暂停停止提交、切任务页卸载 Habitat 并收到 context lost。source/artifact 契约与上述浏览器检查分层列出；物理 GPU/功耗/VRAM 未测。

第一轮右栏隐藏后的后续等待、动态转静态、偏好返回失败；直接比较服务响应与包内原字节的检查也失败。错误没有被改写成通过。实际安装的三个 chunk 与 R3 tgz、当时的 dist 相同，HTTP 响应则多出宿主 source-map trailer；实际 rc3 dsh-client-modules 的 buildComboScript 追加分隔符和 source-map 引用，后续 transport 断言由 D 修正并重新执行。

E 随后只执行原生隐藏定位，没有修改 D 的断言。证据：/tmp/whale-native-20261117/ui-qa-r3-native-hide/。QA_EXIT 0、DSH_STOPPED True；结果是 observations-complete，不是整体性能 passed。已有正向真实提交基线后，隐藏窗口内 GL submissions 与归属 timer 均停止，所有已建 context 都出现 lost；前后真实 tasks 数组为空，模型/任务写入尝试和 pageerror 均为 0。

定位同时确认产品行为：原生右栏重开保持同一 tab/session，但任务页成为当前页，海域 region 已卸载，重新进入后质量由 balanced 回到 auto。源码 FusionNativeTab 在 visible=false 时返回 null。这明确记录为关闭原生右栏会重置插件内部偏好的限制，不能将其算作海域偏好保留通过。任务页往返与原生整个面板卸载是不同路径。

三个 R3 候选 chunk 已从固定原 tgz 读取到 /tmp/whale-native-20261117/candidate-r3/qa-unpacked/package/dist；后续 R3 performance 的 WHALE_PERF_DIST 必须指向这里，避免与最终候选正在重建的 source/packages/plugin/dist 混用。原 tgz SHA-256 仍为本文记录的 440e65da...11fa0da。

新增 QA 文件：

- tests/whale-native-ocean-runtime-qa.mjs：E 持有浏览器与原生会话流程，导航前接入 WHALE_PERF_MODULE；只运行 D 性能模块，保留 failed/pending，不建立第二个 runtime/profile。
- tests/whale-native-native-hide-qa.mjs：独立记录实际原生关闭/重开、真实提交停止、context lost 和偏好重置；不修补产品、不伪造 hidden。
- tests/whale-native-source-status-qa.mjs：最终包仅复验 tgz SHA-256、真实 sources.nodes=unavailable 的精确提示及原生 420px 宿主截图。该脚本已在 Instabox 通过 node --check，随后由父对最终包实际执行通过；详见最终 receipt。预期文案读取自 B 的 collectionNotice + 空列表契约，不拦截真实 state。

新增 runner 的所有环境与路径都通过输入提供；最终包脚本另需 WHALE_QA_TGZ 与 WHALE_QA_ARTIFACT_SHA256。海域 runner 另需 WHALE_PERF_MODULE、WHALE_PERF_SOURCE、WHALE_PERF_DIST、WHALE_PERF_PACKAGE。每次运行均由原 runtime.py 停止同一授权 profile 进程；本轮没有改旧 seed profile。

## 历史候选 8447 的 runtime receipt（已被最终发布候选取代）

此前候选包 SHA-256 为 `844749d046223580c1e7e82c1f5c4e2de6473cf3524c851b5162fa3054c42ca6`，已由 3a317257…85139ee26 发布候选取代。父在同一 fresh 隔离 profile 实际完成脚本，E 只读核对 `/tmp/whale-native-20261117/ui-qa-final-parent/report.json`：status=passed；父运行记录 QA_EXIT 0、DSH_STOPPED True。报告 SHA-256：`758f70749ccfddb19842ac81d3322897697149e0ac4e8219f714d864246b8b05`。

实际运行源码和 CUE 提交 `0769dcf5d5d632f2351221920ed9312fa2dd7e4f` 的两个文件 SHA-256 相同。artifact-binding 与 source-status 已同时跟踪，克隆后的相对 import 完整；根 package.json 直接声明 playwright-core。没有往正在运行的 qa-e-final 目录同步或改写文件。

| 最终包检查 | 实测结果 |
| --- | --- |
| 官方安装与包绑定 | 安装退出 0；client.js/workspace/native-ocean/ocean-scene 四文件与 tgz 逐字节相同，检验器只读 |
| 真实来源提示 | demo=false、sources.nodes=unavailable、nodes=[]；fresh 环境显示“主机来源未配置，暂不能确认当前记录。”，未显示合法空集合文案 |
| 原生入口/聊天共存 | native push，实际拖到 420px；聊天与 composer 可见，没有插件 overlay 或额外 dialog |
| 公开 API | 实际 global ready=true、API 1.1，register/list 能力存在 |
| 最小公开扩展 | A 提供的 fixture 通过真实公开 API 注册并渲染 6 tasks / 3 nodes / topology；task IDs 与拓扑 IDs 核对；dispatch/cancel 回调缺席 |
| 真实与合成边界 | 真实来源先检查；合成输入保留 demo:true，只拦截同源精确 state GET；清理后真实 tasks 仍为空 |
| 异常与写入 | pageErrors=0、consoleErrors=0、浏览器模型/任务写入尝试=0 |
| 后续分层结果 | 两张干净 DEMO 420px 图已由父完成并只读复核；patched-D 性能首轮仍有失败与待验，见后文 |

fresh 自定义 profile 首次只初始化官方 base bundle；E 读实际 rc3 PROFILE_TEMPLATES 后，在该隔离 profile 的原生 bundles 配置中补上 dsh-web-app，Web 服务随后正常产生临时登录 URL。最终包没有因此重新下载或重装，node_modules 未手改。未来 QA 可直接在 fresh DSH_HOME 使用官方 web profile 名称，避免自定义名称默认只选 base 的前置条件。

E 自己的首次最终包 UI 尝试保存在 ui-qa-final，曾因精确文案预期“不可用”与 fresh 实际“未配置”不同而失败；该记录不覆盖父后续 ui-qa-final-parent 的通过结果。父使用 WHALE_QA_SOURCE_MESSAGE 传入实际文案完成验收。两种来源语义均不能折叠为合法空板。

最终脚本额外输入为 WHALE_QA_TGZ、WHALE_QA_ARTIFACT_SHA256、WHALE_QA_INSTALLED_DIST、WHALE_QA_EXTENSION_FIXTURE 和明确的 WHALE_QA_DEMO_SNAPSHOT。WHALE_QA_PUBLIC_PREVIEW=1 才在卸载 QA extension 后生成明确 DEMO 的 420px 任务/海域整宿主图。source/extension 报告本身不含该额外输出；图片随后由父在 ui-qa-final-previews 单独实际完成，见后文。

下面的机器可读 receipt 无 endpoint、登录 URL、Cookie、profile 路径或实际任务正文，可供发布文档汇总。未验项继续保留，不把 R3 截图冒充最终包全矩阵重跑，也不把 HTTP 路由观察等同服务端全部账本审计。

此前候选的机器摘要已由上方当前发布候选 receipt 取代；历史运行原始报告与哈希继续保留。

## 历史候选 8447 的预览与性能快照（2026-11-17T05:31Z）

以下为此前候选当时的三层结果快照，不是当前发布包结论：

1. **Final source/extension 与预览已通过**：SHA-256 `844749d046223580c1e7e82c1f5c4e2de6473cf3524c851b5162fa3054c42ca6` 的四个 installed chunk 与 tgz 精确相同；真实未配置提示、420px push 与聊天共存、真实公开 extension 注册渲染均通过。干净 DEMO 预览另在 ui-qa-final-previews/report.json，status=passed、writes=0、pageErrors=0；报告 SHA-256 `ffc8893705b13497d81ac15e7df48e2dcc0c4b05ebc3b7d80fd1549cc29a8e4d`。两张图是明确合成数据，不代表真实业务任务运行。
2. **R3 settings/navigation 作为历史实测保留**：绑定 R3 的 440e65da...11fa0da 原包。明暗/会话字号、384/420/560 窄栏、1536/1280 视口及 task/host/team 返回与焦点的证据有效；不宣称以上完整矩阵已在最终包重新执行。
3. **最终性能暂未完整通过**：首轮 patched-D 报告已于 2026-11-17T05:31:17.241Z 完成，12 passed / 1 failed / 4 pending，整体 failed。失败是分页按钮点击被 companion 浮动工作台按钮拦截，未走到偏好往返断言；不能据此认定产品偏好真的丢失，也不能把它改记 passed。原生隐藏项 pending 因 runner 缺 verified reopenPanel callback。其余真实团队详情、物理 GPU/功耗/VRAM、原生完整 tab/OS 后台化保持 pending。

最终性能中默认懒加载、静态无 WebGL、真实 GL draw 增长、暂停停止、任务页卸载/context lost、动态转 still 释放、served executable 与候选绑定均有通过记录。它们是浏览器软件生命周期证据，不能提升为硬件能耗或 VRAM 结果。父/D 修正原生执行路径后应生成新的报告；本快照 SHA-256 保留旧轮身份，不覆盖为新轮通过。

干净预览图：

| 文件 | 字节数 | SHA-256 |
| --- | ---: | --- |
| DEMO-native-tasks-420.png | 95066 | f2011e13f25f9129d4f33ab25365cb238f68ea0dbdcbe126c8a36e2a00ccb4f4 |
| DEMO-native-ocean-420.png | 167940 | ba04a328fea0194492e6c052753fb0213479a288838582ec155b89d29c10145b |

两图均位于父的 ui-qa-final-previews 私有证据目录，待公开发布方归档为公开 asset。E 未启动新浏览器、改产品或修改父当前 QA/runtime。
