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
