# 鲸群 beta.15 安全复核

日期：2026-11-24。范围：新增云盘、通知、远端信任、加入包、对齐、预设/热备、
统一状态与真实面板接入；不含 DSH 内核自身和第三方平台服务端。

## 威胁模型

- 本机多方：同一 OS 用户下的其他进程、浏览器页面、MCP 客户端。
- 配置操作者：可设置 provider、URL、环境变量名和 profile 的运维人员。
- 远端主机：可能被攻破或返回伪造/过期清单。
- 第三方平台：可能返回 401、重定向、超大响应或错误正文。
- 本机状态文件：`fleet/`、`imports/`、快照目录、MCP 令牌哈希。

## 已复核控制

### 认证与来源

- MCP 只绑定 `127.0.0.1`，POST `/mcp`，Bearer 令牌 SHA-256 存储；
  浏览器 Origin/非回环 Host 403，无令牌 401，GET 405。
- Web 路由在宿主 `webserver/authorize` 之后执行；自定义认证支持 stable
  `requestRejection` 与 alpha `admit`，不可用时交给宿主默认 `auth: required`。
- 写操作另检 same-origin 与 JSON content-type。

### 权限分离

- `read` scope：只读查询。
- `request` scope：创建派发/对齐 pending、云盘拉取。
- `approve` scope：批准对齐、云盘上传、加入包导入；内部 Bot 令牌不包含 approve。
- 面板写操作仍由宿主登录会话保护。

### 路径与文件

- 云盘上传源文件必须 realpath 落在 `uploadRoots`（默认 imports）内；
  拒绝目录、符号链接、超大文件和越界路径；读取后再次校验大小。
- 导入文件目录 0700、文件 0600；重名追加序号；失败拉取删除临时文件。
- 加入包写入 `hosts/<hostId>.json`，hostId 仅接受 `sha256:<64 hex>`；
  期望清单覆盖前保留 0600 备份。
- 配置恢复只允许写回当前 allowlist 中的原始文件路径；篡改快照 manifest
  指向外部路径会 `backup/path-not-allowed`。
- 预设安装拒绝路径逃逸、未受控覆盖和未修改检测的卸载。

### 远端信任

- hostId 由 Ed25519 公钥派生；加入包校验自身摘要、公钥绑定和清单签名。
- 未信任、过期、签名无效、key-mismatch 一律 unknown；不能保存为期望环境。
- manual 默认；TOFU 必须先验签通过才固定。

### 网络与秘密

- 连接器/通知 URL 必须 HTTPS，只有本机回环允许 HTTP；URL 长度与超时受限。
- 通知 HTTP 适配器 `redirect: "error"`，防止允许 URL 跳转到内网。
- 错误只返回状态码/稳定错误码，不回传平台正文、令牌或 URL。
- 清单中的 bundle source 脱敏 userinfo 和 token/api_key/secret/signature 参数。
- 配置热备明确排除 `host-key.pem`、凭据文件和 SSH 私钥。

## 本轮发现并修复

1. 通知 HTTP 跟随重定向：改为 `redirect: "error"`。
2. 快照恢复未校验 manifest 路径：增加当前 source allowlist 校验。
3. bundle source 可含 URL 用户信息/查询令牌：采集时脱敏。
4. alpha `connection.admit` 与 stable `requestRejection` 不兼容：双契约适配，
   认证不可用时交给宿主。
5. 云盘上传在 stat/read 之间可能变大：读取后再次校验 maxBytes。
6. 加入包覆盖期望清单无备份：写前生成 0600 `.bak-<timestamp>`。

## 残余风险

- operator 可配置任意 HTTPS provider 基址，仍可能指向内网 HTTPS；这是受信配置
  能力，不是匿名输入。
- TOFU 仍是受控网络的便利模式；生产建议 manual。
- 同 OS 用户可修改本机状态、快照和信任表；当前没有跨用户隔离或硬件密钥。
- 远端 manifest 是否在执行时仍新鲜取决于同步频率；门禁依赖 staleAfterSeconds。
- 第三方平台真实账号、重定向、租户策略和超大文件续传未验证。
- 未实现速率限制、密钥值扫描、入站命令或自动重试。

## 验证

- auth 39 项、配置/快照/加入包/连接器/通知定向测试；
- 插件全量 520 项、原生面板 76 项、setup 契约 12 项；
- 未认证 `/fleet/status` 实测 401；
- 真实 alpha/stable UI 和双主机加入包证据见 `/data/openlet/evidence/`。
