# 原生任务执行：操作员与独立复核

日期：2026-11-20。面向隔离环境的操作指南。作业执行为显式 opt-in，插件现有认证、同源写入限制和 job allowlist 仍然生效。

## 责任边界

- DSH 原生任务来源持有任务身份与要求。Fusion 记录一次执行尝试、固定上游任务快照，并在读取时比较当前快照；任务修订或正文等参与来源 token 的内容发生变化时，旧尝试标为过期，不可作为当前复核依据。
- 操作员选择已配置的作业和主机。每次尝试由受支持的 worker adapter 派发，绑定一个任务和一个作业/主机。不要把 `writeScopes` 解释成锁；adapter 的 `jobRoot/<workerTaskId>` 是任务状态、进程身份和 stdout/stderr 的隔离目录，不等于自动切换后的代码工作目录，也不证明跨执行器 fencing。SSH 默认 `jobRoot` 为 `/var/lib/dsh-fusion/jobs`，Instabox 默认值为 `/tmp/dsh-fusion-instabox-jobs`；可被 Host 配置覆盖。普通 v1 作业不会自动建立代码 workspace 或注入 attempt 环境变量；材料 v2 作业按下文创建私有工作区。无论哪种，代码和输入准备仍由 allowlisted command 与固定 pin 决定，服务不会替作业猜测 checkout。
- Worker 回报会把退出码、开始/结束时间及完整捕获到的 stdout/stderr 摘要带入回执。`commandSha256` 仅绑定配置中的命令文本，不包含被命令调用的脚本、代码、依赖或运行时。Fusion 校验观察字段与回执摘要；回执没有作业源代码、完整运行环境、任意文件清单或真实终端屏幕录像的证明。
- 需要材料验收的作业可以配置固定的 code/input/runtime/config 文件摘要和 artifact 路径/字节数。适配器会为 attempt 创建唯一的私有 `jobRoot/<workerTaskId>/workspace`，以非登录 shell 的 `FUSION_ATTEMPT_*` 环境变量和当前目录交给 allowlisted command；它不会自动检出 DSH 任务引用或准备依赖，作业必须在此唯一工作区内按固定规则准备代码和输入。终态后适配器再从同一 worker 读取受限文件字节，拒绝绝对路径、`..`、符号链接、超大文件和工作区身份或来源摘要不匹配。worker 在 stdout 中报告的 manifest 只作提示，不能替代适配器读取。没有适配器读取、任一摘要不匹配，或 runtime 只有 `declared` 身份时，作业不可启动或 attempt 保持“未确认”，不会生成 v2 材料回执。
- 与执行身份独立的 reviewer 应重新阅读同一任务 revision，在主机上检查本次尝试涉及的代码、输入和实际产物，核对日志、退出状态及自己的复现/测试，并自行决定 `passed` 或 `failed`。当前服务只验证配置 reviewer 公钥对应的 Ed25519 签名、任务 owner 不同以及签名绑定了回执；`reviewerId` 仍由导入内容声明，DSH authenticated actor / operator / executor principal 尚未绑定到签名，因此系统目前不能证明签名者就是独立于执行者的真实审核人。只有 reviewer 从受控身份实际复查这些材料后，才可在操作流程中称为独立复核；UI 显示签名有效不代表身份独立性已由系统证明。签名也不证明文件内容、测试质量或真实 LAN/多 Host 端到端链路。

## 配置

配置放在当前 DSH profile 的 `dsh-fusion` 行。只有列出的作业 id、命令和节点可从面板选择；评估风险后逐项授权，避免提供任意命令入口。示例均为合成标识：

```yaml
- id: dsh-fusion
  config:
    taskLedgerPath: /var/lib/dsh/fusion-tasks.json
    nativeTaskExecution:
      jobs:
        - id: verify-example
          label: Example verification
          command: /opt/dsh-fusion/review-jobs/verify-example.sh
          nodeIds:
            - isolated-worker
          requireMaterials: true
          expectedMaterials:
            code: { path: src/revision.txt, digest: <64-char-sha256> }
            input: { path: inputs/test.json, digest: <64-char-sha256> }
            runtime: { path: runtime/identity.json, digest: <64-char-sha256>, evidence: measured }
            config: { path: config/checks.json, digest: <64-char-sha256> }
            artifacts:
              - { path: dist/result.bin, digest: <64-char-sha256>, bytes: 1024 }
      reviewerKeys:
        reviewer-example: |-
          -----BEGIN PUBLIC KEY-----
          <Ed25519 SPKI public key PEM>
          -----END PUBLIC KEY-----
```

节点 `isolated-worker` 还须通过宿主现有 `sshNodes` 或 `instaboxNodes` 配置。私钥只交给 reviewer 本机的受保护密钥文件，不放在 profile、插件配置、仓库、任务、回执、日志或聊天中。不给 `nativeTaskExecution` 配置则端点保持关闭；审查配置需另行加载 reviewer 公钥，因此改动配置后按宿主正常方式重载插件。未显式设置 `directory` 时，账本目录为 `${taskLedgerPath}.executions`；两者都不可用时，执行服务不会创建。将真实账本放在仅插件服务账号可读写的受保护位置。

示例命令指向部署者维护的 allowlisted wrapper；Fusion 不提供这个脚本，也不假定其存在。该 wrapper 应使用 `mktemp -d` 等方法创建每次运行唯一的工作目录，在那里检出固定输入版本，核对运行脚本和依赖，并把 workspace 路径与输入提交号写入 stdout，以便回执摘要可关联。签名 `commandSha256` 不等于 wrapper 文件 SHA-256；reviewer 还须独立读取并记录 wrapper、实际执行代码和必要输入的字节摘要。

上方示例中的 `<64-char-sha256>` 只是文档占位文字，不是有效配置值。实际作业 profile 必须先在受控来源计算出每个固定文件和 artifact 的 SHA-256/字节数，再填写完整 pin；没有真实期望值时应保持材料作业未配置。

Worker 以非登录的 Bash 执行 allowlisted command，不读取远端登录 profile，也不运行登录 shell 的退出清理脚本。不要依赖 `.bash_profile`、`.bashrc` 或 `.bash_logout` 来提供 PATH、凭据、工作目录或其他运行条件；需要的 PATH 和环境变量必须由 allowlisted wrapper 显式配置，并在复核材料中说明其来源。这样可以让命令退出码和捕获回执由作业本身决定，而不是被主机登录钩子改写。

## 操作与核验

1. 在任务优先面板打开原生任务，检查当前 revision、要求、依赖、owner 与 write scope 警告。来源不可用或过期时停止，不应重派来掩盖不确定状态。
2. 选择固定作业与单个允许主机，启动后查看 attempt、worker task 和来源状态。接受回执只表示观察到的执行事实已通过结构校验；退出码 0 和 `completed` 本身都不是验收。
3. 在面板“复制回执供复核”或展开 JSON，保存到 reviewer 的受控本地文件。reviewer 先从回执核对 taskId、attemptId、jobId、nodeId、workerTaskId、commandSha256、时间、退出码、stdout/stderr SHA-256 和字节数。独立连接该 worker，确认 adapter 目录、wrapper 路径、stdout 报告的唯一 workspace 和产物。重新取得实际执行脚本、固定输入与产物字节并计算 SHA-256；将预期证据与实际内容和日志逐项比较，记录依据和差异。仅 stdout/stderr 摘要无法替代对产物字节的检查；若 adapter 没提供可追溯目录、attempt 唯一 workspace 或产物，复核结论应为 `failed` 或暂缓，而不是猜测成功。
4. reviewer 从唯一标识的受控身份读取私钥，并把具体理由写入 UTF-8 摘要文件。运行签名工具，将标准输出重定向到待导入文件，再在面板“导入签名复核”粘贴其 JSON 内容。签名前不应在文件里写未核实的 `passed` 结论。Fusion 会验证 Ed25519 签名、公钥、任务当前来源、回执摘要和不同于任务 owner 的 reviewer id；保存后再次读取面板状态，确认结论绑定到预期 attempt 和 receipt。若任务 revision 变更，停止引用旧复核并对新来源重新执行与审核。

样例命令。所有文件都必须由操作员按本机访问控制保存；私钥绝不作为命令行值传入：

```sh
umask 077
node scripts/sign-native-execution-review.mjs \
  --receipt /secure/local/receipt.json \
  --reviewer reviewer-example \
  --verdict passed \
  --summary-file /secure/local/review-summary.txt \
  --private-key /secure/keys/reviewer-example-ed25519.pem \
  > /secure/local/review.json
```

`verdict` 只接受 `passed` / `failed`。签名输入为 UTF-8 的 `JSON.stringify(['dsh-native-execution-review/v1', taskId, attemptId, receiptSha256, reviewerId, verdict, summary])`；签名为 Ed25519，输出是标准带 padding base64。summary 字节（包括换行）会被签名，并且须非空、不含 NUL 且不超过 2048 UTF-8 字节。工具要求 receipt 字段精确匹配当前 native receipt schema，包含全部已知键且无额外键，并重算 native receipt digest；收到无法校验的回执、编码、键或签名问题时以非零退出且不打印签名。命令行参数只包括文件路径和非秘密元数据；标准输出只含待导入签名 JSON，错误只给通用原因。shell 的命令历史、`set -x` 跟踪、终端录屏及日志仍须按本地策略保护；不要将重定向结果追加到公共日志。

导入 JSON 只含 UI/API 当前接受的七个字段。任何一个输入身份不匹配都不要编辑字段来绕过校验：重新从本次 attempt 取得回执、复核材料并签名。reviewer key 轮换会使已有签名无法按当前公钥重验，应保存轮换记录并对当前 attempt 重新审核。

导入前可先用公钥离线校验，确认待粘贴内容没有被改动，并确认它绑定的正是本次回执：

```sh
node scripts/sign-native-execution-review.mjs \
  --verify /secure/local/review.json \
  --public-key /secure/local/reviewer-example-ed25519.pub.pem \
  --receipt /secure/local/receipt.json
```

成功时输出 `verified: true`、`receiptBound: true`，以及 task / attempt / receipt 摘要、reviewer、verdict 和摘要字节数；签名不符、摘要被改、出现未签名字段或回执不一致都以非零退出。省略 `--receipt` 时只校验签名本身，`receiptBound` 为 `false`。这一步只证明签名与该公钥、该回执一致，不证明 reviewer 与执行者是不同的人；该身份独立性仍需操作流程与 DSH 认证身份另行核对。

## 验收边界

本文件及本地 CLI 验证只说明所列的格式、签名和校验行为。单机隔离 worker 上验证配置和命令可用，不足以证明真实 LAN、两台物理主机、生产 DSH profile、跨主机租约、真实产物业务正确性或 OpenLET 任务成绩。需要这类证据时，分别记录明确授权、Host 身份、精确提交和配置、执行输入/产物 hash、时间、日志路径及故障恢复结果；没有实际执行的不要描述成通过。
