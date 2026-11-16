# 鲸交互展厅

地址：https://whale-panel.whale-muyi123567.workers.dev/

Cloudflare Worker whale-panel 只分发白名单内的公开静态文件，来源固定到本仓库
gh-pages 的构建快照SHA；不透传任意URL，没有机器凭据、API、任务派发或模型调用。
GET/HEAD之外的方法拒绝，CSP限制脚本/资源来自自身。返回X-Whale-Source用于核对版本。

开发在CUE，全部构建/测试在授权Instabox；静态发行文件保存在gh-pages。
preview-worker.mjs保存实际Worker代码；preview-worker-config.json记录兼容日期与来源。
升级时先完成截图/交互审查，再提交新的gh-pages快照，更新固定SHA及文件白名单并部署。
回滚只需恢复前一个Worker版本或固定的源码SHA。无需修改已有个人网站和域名记录。

2026-11-16 已通过HTTPS200读回，并在Instabox浏览器实际打开公开HTTP入口，
完成三版导航切换且无页面异常。页面均为显式合成数据，不代表实际机器在线。

鲸入深海预览更新：根路径与whale-dive.html展示实时3D动画，design-gallery.html保留三版合成数据面板。模型与纹理只从固定Git提交的白名单分发。CSP仅增加同源和blob以允许GLB纹理解码，不连接执行后端。模型使用Grab3D CC0，Three.js使用MIT，许可随静态资源分发。旧静态提交1e2d9d93a525499e17c1d6aef2dd4c9305414de4可用于回滚。

2026-11-17 场景版：根路径和whale-habitat.html展示鲸群海域；旧whale-dive.html与design-gallery.html仍可访问。
采用单Canvas、共享鲸模型、GPU fence限制在途画面、24/15fps预算及按绘制负载降级。回滚静态来源为e8d7a19c13e5c0b4bb975ce7f21cc9d4be668487。
未提供统一定时任务数据源，公开页面中的定时触发均标为合成演示。部署没有机器执行凭据。
