# beta.14 安装命令与验证契约

本说明对照 Fusion 安装器与 DSH CLI 的实际实现，描述命令语义；不声称升级回滚矩阵已通过。
本轮推荐 rc.3，仅依据隔离启动 / UI 实测范围。已核对的旧宿主也有所需右栏 API，
不标 unsupported；rc.1 的旧包 verified 不覆盖 beta.14 与旧宿主的运行组合。

## 宿主安装 Fusion

~~~sh
dsh plugin --profile web add ./dsh-fusion-0.2.0-beta.14.tgz
~~~

`--profile` 必须在转交的 `add` 参数前。`add` 是 DSH 转交给包管理器的真实操作，
相对包路径按调用目录解析，命令在目标 profile 内安装依赖。
已有 profile 使用此入口安装新 tarball；新 profile 由宿主初始化。
`web` 是示例名称，不应覆盖未经授权的实际 profile；升级前保留旧包与 profile / 状态备份。

实现依据：上游 `deepseek-ai/deepseek-harness` 固定
`39163dd30f703a79079e2d2446545cff3c453738`：
`apps/cli/src/args.ts` 的 plugin 参数转交、`apps/cli/src/plugin.ts` 的 `runPlugin`，
以及 `packages/boot/plugin-manager/src/operations.ts` 的路径锚定和 `runPluginCommand`。
本说明没有执行安装命令，也不改变生产 profile。

## setup 与 companions

先由宿主安装新 Fusion 包，再运行新包内的 setup；setup 加载的是自身包目录的发布契约。
普通 setup 安装或校验该契约选择的 companions，不会在未提供 `--fusion-tgz` 时自行升级 Fusion。
以 setup 直接创建新 profile 时，必须同时提供 `--fusion-tgz`。
`--force-companions` 是显式替换不同版本 companions 的开关，不是开启模型的开关。

POSIX shell 示例使用安装器相同的 `DSH_HOME` 默认值：

~~~sh
node "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-fusion/scripts/setup.mjs" --profile web
node "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules/dsh-fusion/scripts/setup.mjs" --profile web --verify
~~~

Windows PowerShell 的对应示例：

~~~powershell
$dshProfileRoot = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }
node (Join-Path $dshProfileRoot 'profiles/web/node_modules/dsh-fusion/scripts/setup.mjs') --profile web
node (Join-Path $dshProfileRoot 'profiles/web/node_modules/dsh-fusion/scripts/setup.mjs') --profile web --verify
~~~

`--verify` 只核对当前已安装版本、必要入口、发布契约、所选 companions 与合成配置，
不安装、不升级，不验证所有多机业务，也不替代下载包 SHA-256 校验。
自定义安装位置还需保证 `--dsh-home`、`--profile` 和 `--dsh-bin` 指向同一目标环境。
实现依据为 [installer.mjs](../../packages/plugin/scripts/installer.mjs) 的参数解析、
`runSetup`、`verifyInstall` 和 `--fusion-tgz` 分支。

查看面板不要求开启模型或发送消息；模型写入与远程终端仍默认关闭。
升级后是否正确加载新 UI、回滚与状态恢复是否完成，需要在对应宿主和目标包上另行验证。
最终产物与实测结果见 [beta.14 发布说明](../releases/2026-11-17-beta14.md)。
