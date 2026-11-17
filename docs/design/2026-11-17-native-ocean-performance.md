# 海域轻量化与生命周期验收（一页）
日期：2026-11-17。结论：最终候选14 passed、0 failed、3 pending；已执行范围通过，总状态保留incomplete。

**候选与环境。** 源点dec1bac（CUE完整提交dec1bacf1cf0a47fbe9c46d1e0090d9578855e39）；安装包SHA-256：3a317257ceb5e4f77b756c9e72a63530e56e73146109ecd5613163385139ee26。Instabox真实DSH、Chromium 154.0.8037.57；运行时间2026-11-17 05:40:42–05:41:12 UTC。已独立读取ui-qa-publish-performance/runtime-report.json与performance/report.json：1项源码契约、4项产物契约、9项浏览器检查通过；模型/任务写入尝试、page错误、console错误均0，前后真实来源均非演示且0任务/0主机。父执行回执另确认QA_EXIT0、DSH_STOPPED=True。

**轻量化目标。** 默认任务/主机/团队不加载3D；海域显式进入才加载，画面高度200–360px，每组最多三鲸，控件跟随宿主字体与语义色。暂停、隐藏和卸载停止场景；内部页签往返保留偏好。宿主关闭会卸载面板，重开默认任务，不要求跨卸载保留海域状态。

| 目标 | 本候选实际结果 |
| --- | --- |
| 默认不加载3D；静态无WebGL | 通过：默认只请求workspace；静态上下文创建尝试0，无scene请求 |
| 动态确有绘制；暂停停止 | 通过：真实WebGL2 draw 76→1406；暂停提交1560→1560，pending timer=0 |
| 任务页卸载、原生关闭 | 通过：任务页提交3440→3440；原生关闭总提交5040→5040，context均lost、timer无增长且pending0；重开默认任务，再显式入海域 |
| 动态转静态 | 通过：总提交6480→6480，context均lost，没有新建上下文 |
| 内部页签返回偏好与分页 | 通过：明确demo:true四团队，普通点击实际进入第二组，返回后仍为海面、节能、暂停且paginationBeyondFirstPage=true；未forceclick |
| 候选包→dist→HTTP | 通过：包及chunk绑定一致，传输尾部按严格规则检查，原始哈希完整保留 |

**传输独立复核。** 已读取最终归档served-client.workspace.js、native-ocean、ocean-scene完整响应体；三个候选前缀、响应体及suffix的SHA-256均匹配JSON。尾部仅“;\n//# sourceMappingURL=<对应文件名>.map?rev=<12位修订>\n”，分别64/67/66字节，与官方buildComboScript一致；不是执行代码转译。父云端7项比较器断言覆盖原字节/合法尾部接受及二次分隔符、执行代码、U2028、前缀变化拒绝。公开预览三团队截图与性能四团队输入分别记证，不将合成数据写成真实协作验收。

**仅余三项未验。** ①真实团队详情→返回的身份及偏好：DEMO按钮有意禁用；②物理GPU利用率、能耗与VRAM回收：没有硬件profiler，WebGL调用/contextlost不替代；③完整原生页签移除与真实OS后台化：本轮覆盖右栏关闭及Habitat卸载。场景实际使用timer，RAF无正向基线，不另宣称“RAF停止已测”。本报告不把这三项改为通过。

证据根：/tmp/whale-native-20261117/ui-qa-publish-performance；详见runtime-report.json、performance/report.json及served-client.*.js。父已确认final-source/extension门禁，独立视觉材料另归档于ui-qa-final-previews与既有420px列表/详情。本路仅只读证据并更新本报告，未改产品/主树QA、未本机应用测试、未push；任何后续候选变更需重新绑定证据。
