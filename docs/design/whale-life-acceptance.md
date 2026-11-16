# Life 场景验收
依据 imagery prompt v2 和只读 life-types.ts。仅显式合成演示，不证明真实业务运行时。未运行测试，由父线统一 Instabox 执行。

## 语义评审
启动首帧不补播既有 online/completed/lastRun。
SSH offline→online 对应 host-online，只表示主机可达。
queued/claimed→running 对应 task-start；running→verifying 对应 task-verify，禁止 task-complete。
新 completed 边沿对应 task-complete 与 task ID；动画结束不代表完成。
subagent-start/stop 必须对应明确子代理 ID，idle 不代表任务完成。
schedule-trigger 需要真实或明确合成 schedule 来源及新 lastRunId；无来源零海鸥并显示未接入。
source-stale 代表失去观测，不产生 host-offline 或业务完成；恢复只接当前状态。
无子代理来源零海豚。所有 cue 必须有文字与实体 ID。

## UI 对照与执行
现有类型支持 cue kind/entityId/label；habitat QA 已有暂停/继续按钮。
情境选择器和 cue DOM 尚待父线适配：默认 select[aria-label=情境演示]，cue 使用 data-cue-kind/data-entity-id。WHALE_LIFE_SELECTORS JSON 可覆盖 root/scenario/cue/pause/resume。
父线设置 WHALE_LIFE_URL（或 WHALE_HABITAT_URL）、WHALE_EVIDENCE_DIR、WHALE_LIFE_MANIFEST，可选 CHROMIUM_PATH；运行 node tests/whale-life-qa.mjs。
Manifest 是独立评审 JSON：synthetic:true、cases 数组。每项 name、steps（情境 option value 顺序）、cueText、expectedCue:{kind,entityId}、forbiddenKinds、entityCounts。无新 cue 可设 noNewCue:true，必须评审禁止 kind 完整性。
必需 name：startup/ssh-online/task-running/task-verifying/task-completed/subagent/schedule/stale/no-subagents/no-schedules。
entityCounts 键由父线与实际 renderer data-habitat-metrics 对齐。缺计数为未验证，不从 fixture 冒造计数。无来源负例须明确零值期望。禁止由页面实际结果反向生成期望。
Instabox Chromium swiftshader；先暂停再截图，finally 继续；不与 habitat 90 秒趋势并发。
独立 life-result.json 和场景 PNG；缺 manifest/计数 incomplete 非零退出，失败非零退出。

## 保留范围
DOM 展示不证明真实执行；截图需人工检查意象。
证据入口可用性、重复快照去重、首帧历史抑制、stale 恢复应由父线导演纯函数或事件历史测试补足，本脚本不宣称覆盖。
只写验收脚本，不重做 habitat 性能与 90 秒测试。

父线 UI 9d7a3eb options：startup/ssh/start/verify/complete/subagent/schedule/stale。每步等待 data-demo-state 的 case:event:replay 阶段后断言，避开 500ms baseline。name 与 option 不同，由 manifest.steps 映射。无来源负例入口仍待父线适配。
