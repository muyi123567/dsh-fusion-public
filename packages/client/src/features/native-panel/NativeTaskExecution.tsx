import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { TaskRecord, VerifiedExecutionMaterials } from "@dsh-fusion/core";
import { fusionBrowserUrl } from "../../routes.js";
import type { NativePanelData } from "./types.js";
import styles from "./native-task-execution.module.css";

const PATH = "/plugins/dsh-fusion/tasks/execution";
const SHA256 = /^[0-9a-f]{64}$/;
const REVIEW_FIELDS = ["taskId", "attemptId", "receiptSha256", "reviewerId", "verdict", "summary", "signature"] as const;

interface NativeExecutionReceipt {
  sha256: string;
  taskId: string;
  sourceToken: string;
  attemptId: string;
  jobId: string;
  nodeId: string;
  workerTaskId: string;
  commandSha256: string;
  dispatchFingerprint: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  stdout: { sha256: string; bytes: number };
  stderr: { sha256: string; bytes: number };
  materials?: VerifiedExecutionMaterials;
}

interface NativeExecutionReview {
  reviewerId: string;
  verdict: "passed" | "failed";
  summary: string;
  state: "current" | "stale";
  reviewedAt: string;
  receiptSha256: string;
}

interface NativeExecutionAttemptView {
  id: string;
  taskId: string;
  sourceToken: string;
  jobId: string;
  nodeId: string;
  requestId: string;
  workerTaskId: string;
  createdAt: string;
  sourceState: "current" | "stale" | "unavailable";
  executionState: "pending" | "running" | "unconfirmed" | "exited";
  receipt?: NativeExecutionReceipt;
  review?: NativeExecutionReview;
}

interface NativeExecutionData {
  jobs: { id: string; label: string; nodeIds: string[]; requiresMaterialVerification?: boolean; materialVerificationAvailable?: boolean }[];
  attempts: NativeExecutionAttemptView[];
  taskAvailable: boolean;
  sourceToken?: string;
  sourceUnavailable?: boolean;
  sourceRevision?: number;
  sourceGoal?: string;
  sourceDescription?: string;
}

type SignedReview = Pick<NativeExecutionReview, "reviewerId" | "verdict" | "summary" | "receiptSha256"> & {
  taskId: string;
  attemptId: string;
  signature: string;
};

interface Props { task: TaskRecord; data: NativePanelData }

// Retain an unconfirmed request when navigating away from the details or when the source changes.
const awaitingRequest = new Map<string, string>();
const executionLabels = { pending: "等待执行", running: "运行中", unconfirmed: "状态未确认", exited: "已退出" };
const sourceLabels = { current: "当前修订", stale: "来源已变更", unavailable: "来源不可用" };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isLogDigest = (value: unknown) => isObject(value) && typeof value.sha256 === "string"
  && typeof value.bytes === "number" && Number.isSafeInteger(value.bytes) && value.bytes >= 0;

function isMaterialReceipt(value: unknown): value is NonNullable<NativeExecutionReceipt["materials"]> {
  if (!isObject(value) || !isObject(value.expected) || !isObject(value.observed)) return false;
  const expected = value.expected;
  const observed = value.observed;
  if (observed.version !== 1 || !isObject(observed.workspace)
    || typeof observed.workspace.id !== "string" || typeof observed.workspace.path !== "string"
    || !isObject(expected.source) || typeof expected.source.revision !== "string"
    || typeof expected.source.digest !== "string" || !Array.isArray(expected.artifacts)
    || !Array.isArray(observed.artifacts)) return false;
  for (const key of ["code", "input", "runtime", "config"]) {
    const file = expected[key];
    if (!isObject(file) || typeof file.path !== "string" || typeof file.digest !== "string") return false;
  }
  return true;
}

function isAttempt(value: unknown, taskId: string): value is NativeExecutionAttemptView {
  if (!isObject(value) || value.taskId !== taskId
    || !["id", "sourceToken", "jobId", "nodeId", "requestId", "workerTaskId", "createdAt"].every(key => typeof value[key] === "string")
    || typeof value.sourceState !== "string" || !Object.hasOwn(sourceLabels, value.sourceState)
    || typeof value.executionState !== "string" || !Object.hasOwn(executionLabels, value.executionState)) return false;

  const { receipt, review } = value;
  if (receipt !== undefined && (!isObject(receipt) || receipt.taskId !== taskId || receipt.attemptId !== value.id
    || receipt.sourceToken !== value.sourceToken || receipt.jobId !== value.jobId || receipt.nodeId !== value.nodeId
    || receipt.workerTaskId !== value.workerTaskId || typeof receipt.exitCode !== "number" || !Number.isSafeInteger(receipt.exitCode)
    || !["sha256", "commandSha256", "dispatchFingerprint", "startedAt", "finishedAt"].every(key => typeof receipt[key] === "string")
    || !isLogDigest(receipt.stdout) || !isLogDigest(receipt.stderr)
    || (receipt.materials !== undefined && !isMaterialReceipt(receipt.materials)))) return false;

  return review === undefined || (isObject(review)
    && (review.state === "stale" || (review.state === "current" && value.sourceState === "current" && isObject(receipt)))
    && typeof review.receiptSha256 === "string" && SHA256.test(review.receiptSha256)
    && (!isObject(receipt) || review.receiptSha256 === receipt.sha256)
    && (review.verdict === "passed" || review.verdict === "failed")
    && ["reviewerId", "summary", "reviewedAt"].every(key => typeof review[key] === "string"));
}

function decodeExecutionData(value: unknown, taskId: string): NativeExecutionData {
  if (!isObject(value) || !Array.isArray(value.jobs) || !Array.isArray(value.attempts) || typeof value.taskAvailable !== "boolean"
    || (value.sourceToken !== undefined && typeof value.sourceToken !== "string")
    || !value.jobs.every(job => isObject(job) && typeof job.id === "string" && typeof job.label === "string"
      && Array.isArray(job.nodeIds) && job.nodeIds.every(node => typeof node === "string")
      && (job.requiresMaterialVerification === undefined || typeof job.requiresMaterialVerification === "boolean")
      && (job.materialVerificationAvailable === undefined || typeof job.materialVerificationAvailable === "boolean"))
    || !value.attempts.every(attempt => isAttempt(attempt, taskId))) {
    throw new Error("执行数据格式不完整");
  }
  return value as unknown as NativeExecutionData;
}

function requestUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const hex = (start: number, end: number) => Array.from(bytes.slice(start, end), byte => byte.toString(16).padStart(2, "0")).join("");
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return [hex(0, 4), hex(4, 6), hex(6, 8), hex(8, 10), hex(10, 16)].join("-");
}

function decodeSignedReview(raw: string, receipt: NativeExecutionReceipt): SignedReview {
  const value: unknown = JSON.parse(raw);
  if (!isObject(value) || Object.keys(value).length !== REVIEW_FIELDS.length || !REVIEW_FIELDS.every(key => typeof value[key] === "string")) {
    throw new Error("请粘贴完整的签名复核 JSON");
  }
  if (value.taskId !== receipt.taskId || value.attemptId !== receipt.attemptId || value.receiptSha256 !== receipt.sha256) {
    throw new Error("签名复核与此回执不匹配");
  }
  if ((value.verdict !== "passed" && value.verdict !== "failed")
    || !String(value.reviewerId).trim() || !String(value.summary).trim() || !String(value.signature).trim()) {
    throw new Error("签名复核字段不完整");
  }
  return value as unknown as SignedReview;
}

function postExecution(path: string, body: object) {
  return fetch(fusionBrowserUrl(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
}

export function NativeTaskExecution({ task, data }: Props) {
  const revision = task.agentTeamTask?.revision;
  if (!task.id.startsWith("dsh-native-team:") || !Number.isSafeInteger(revision) || data.model.demo) return null;
  const key = JSON.stringify([task.id, revision, task.goal, task.description, !!data.error]);
  return <ExecutionPanel key={key} task={task} data={data} />;
}

function ExecutionPanel({ task, data }: Props) {
  const [panel, setPanel] = useState<NativeExecutionData>();
  const [readState, setReadState] = useState<"reading" | "ready" | "error" | "disabled">("reading");
  const [jobId, setJobId] = useState("");
  const [nodeId, setNodeId] = useState("");
  const [mutating, setMutating] = useState(false);
  const [notice, setNotice] = useState("");
  const active = useRef(false);
  const mutation = useRef(false);
  const reader = useRef<AbortController>();
  const taskId = task.id;

  const refresh = useCallback(async () => {
    if (!active.current || reader.current) return;
    const controller = new AbortController();
    reader.current = controller;
    setReadState("reading");
    try {
      const response = await fetch(fusionBrowserUrl(`${PATH}?taskId=${encodeURIComponent(taskId)}`), {
        signal: controller.signal, cache: "no-store",
      });
      if (controller.signal.aborted) return;
      if (response.status === 404) {
        setPanel(undefined);
        setReadState("disabled");
        return;
      }
      if (!response.ok) throw new Error("读取失败");
      const value = decodeExecutionData(await response.json(), taskId);
      if (controller.signal.aborted) return;
      const requestId = awaitingRequest.get(taskId);
      if (requestId && value.attempts.some(attempt => attempt.requestId === requestId)) awaitingRequest.delete(taskId);
      setPanel(value);
      setReadState("ready");
    } catch {
      if (!controller.signal.aborted) setReadState("error");
    } finally {
      if (reader.current === controller) reader.current = undefined;
    }
  }, [taskId]);

  useEffect(() => {
    active.current = true;
    void refresh();
    return () => {
      active.current = false;
      reader.current?.abort();
      reader.current = undefined;
    };
  }, [refresh]);

  const job = panel?.jobs.find(row => row.id === jobId);
  const workerSelected = job?.nodeIds.includes(nodeId) ?? false;
  const awaiting = awaitingRequest.has(taskId);
  const sourceIssue = !panel ? undefined
    : panel.sourceUnavailable || data.error ? "任务来源不可用"
    : !panel.taskAvailable ? "来源未返回此任务"
    : !panel.sourceToken ? "来源未提供执行凭据"
    : task.status === "completed" || task.status === "cancelled" ? "任务已结束，不能重新执行"
    : (panel.sourceRevision !== undefined && panel.sourceRevision !== task.agentTeamTask?.revision)
      || (panel.sourceGoal !== undefined && panel.sourceGoal !== task.goal)
      || (panel.sourceDescription !== undefined && panel.sourceDescription !== task.description)
      ? "任务来源已更新，请刷新任务详情" : undefined;
  const sourceMatches = !!panel && !sourceIssue;
  const actionReady = readState === "ready" && sourceMatches && !mutating;
  const alreadyRegistered = workerSelected && panel?.attempts.some(attempt =>
    attempt.sourceToken === panel.sourceToken && attempt.jobId === jobId && attempt.nodeId === nodeId);
  const upstreamBlocked = task.agentTeamTask?.ready === false;
  const canStart = actionReady && workerSelected && !awaiting && !alreadyRegistered && !upstreamBlocked;

  async function acceptAttempt(response: Response, match: (attempt: NativeExecutionAttemptView) => boolean) {
    const body: unknown = await response.json();
    const value = isObject(body) && "attempt" in body ? body.attempt : body;
    if (!isAttempt(value, taskId) || !match(value)) throw new Error("执行记录不匹配");
    const attempt = value;
    if (active.current) setPanel(previous => {
      if (!previous) return previous;
      const attempts = previous.attempts.some(row => row.id === attempt.id)
        ? previous.attempts.map(row => row.id === attempt.id ? attempt : row)
        : [attempt, ...previous.attempts];
      return { ...previous, attempts };
    });
  }

  async function start() {
    if (!canStart || !panel?.sourceToken || mutation.current || reader.current || awaitingRequest.has(taskId)) return;
    const requestId = requestUuid();
    awaitingRequest.set(taskId, requestId);
    mutation.current = true;
    setMutating(true);
    setNotice("");
    try {
      const response = await postExecution(PATH, { taskId, sourceToken: panel.sourceToken, jobId, nodeId, requestId });
      if (response.ok) {
        await acceptAttempt(response, attempt => attempt.requestId === requestId);
      } else if ([400, 401, 403, 404, 409, 410, 413, 415, 422].includes(response.status)) {
        if (awaitingRequest.get(taskId) === requestId) awaitingRequest.delete(taskId);
        if (active.current) setNotice(`启动未获接受（${response.status}）`);
      }
    } catch {
      // The server may have accepted the operation before the response was lost.
    } finally {
      if (active.current) {
        await refresh();
        setMutating(false);
      }
      mutation.current = false;
    }
  }

  async function submitReview(review: SignedReview) {
    if (!actionReady || mutation.current || reader.current) return false;
    mutation.current = true;
    setMutating(true);
    setNotice("");
    let accepted = false;
    try {
      const response = await postExecution(`${PATH}/review`, review);
      if (response.ok) {
        await acceptAttempt(response, attempt => attempt.id === review.attemptId && attempt.review?.receiptSha256 === review.receiptSha256);
        accepted = true;
      } else if (active.current) {
        setNotice(`复核未获接受（${response.status}）`);
      }
    } catch {
      if (active.current) setNotice("复核提交结果未确认，请核对下方记录。");
    } finally {
      if (active.current) {
        await refresh();
        setMutating(false);
      }
      mutation.current = false;
    }
    return accepted;
  }

  if (readState === "disabled" || (readState === "reading" && !panel)) return null;
  return <section className={styles.section} aria-label="任务执行">
    <div className={styles.header}>
      <h3>任务执行</h3>
      <button type="button" onClick={() => void refresh()} disabled={readState === "reading" || mutating}>刷新执行状态</button>
    </div>
    {readState === "error" && <p role="alert">无法读取执行状态{panel ? "，下方为上次读取的记录。" : "，请刷新重试。"}</p>}
    {sourceIssue && <p className={styles.note}>{sourceIssue}，暂不可操作。</p>}
    {awaiting && !mutating && <p role="status">提交结果尚未确认，请刷新执行状态。</p>}
    {notice && <p role="alert">{notice}</p>}
    {upstreamBlocked && sourceMatches && <p className={styles.note}>上游任务未就绪，暂不可启动。</p>}
    {panel?.jobs.some(row => row.requiresMaterialVerification && !row.materialVerificationAvailable)
      && <p className={styles.note}>材料校验作业暂不可用：需固定材料摘要、具备适配器文件读取能力，并提供可实测的运行时身份文件。</p>}
    {panel && panel.jobs.some(row => row.nodeIds.length > 0) && <div className={styles.controls}>
      <label>执行作业<select value={job?.id ?? ""} disabled={!actionReady || awaiting} onChange={event => { setJobId(event.target.value); setNodeId(""); }}>
        <option value="">选择作业</option>
        {panel.jobs.filter(row => row.nodeIds.length > 0).map(row => <option key={row.id} value={row.id}>{row.label}{row.requiresMaterialVerification ? " · 材料校验" : ""}</option>)}
      </select></label>
      <label>执行主机<select value={workerSelected ? nodeId : ""} disabled={!actionReady || !job || awaiting} onChange={event => setNodeId(event.target.value)}>
        <option value="">选择主机</option>
        {job?.nodeIds.map(id => <option key={id} value={id}>{data.nodes.find(node => node.id === id)?.name ?? id}</option>)}
      </select></label>
      <button type="button" className={styles.primary} disabled={!canStart} onClick={() => void start()}>启动执行</button>
    </div>}
    {alreadyRegistered && <p className={styles.note}>此作业已在所选主机登记。</p>}
    {panel?.attempts.length === 0 && <p className={styles.note}>{panel.jobs.some(row => row.nodeIds.length > 0) ? "暂无执行记录。" : "未配置可执行的作业与主机。"}</p>}
    {panel?.attempts.map(attempt => <ExecutionAttempt key={attempt.id} attempt={attempt}
      jobLabel={panel.jobs.find(row => row.id === attempt.jobId)?.label ?? attempt.jobId}
      nodeLabel={data.nodes.find(node => node.id === attempt.nodeId)?.name ?? attempt.nodeId}
      fresh={readState !== "error" && sourceMatches}
      reviewable={sourceMatches && attempt.sourceState === "current" && attempt.sourceToken === panel.sourceToken}
      reviewEnabled={actionReady}
      onReview={submitReview} />)}
  </section>;
}

function ExecutionAttempt({ attempt, jobLabel, nodeLabel, fresh, reviewable, reviewEnabled, onReview }: {
  attempt: NativeExecutionAttemptView;
  jobLabel: string;
  nodeLabel: string;
  fresh: boolean;
  reviewable: boolean;
  reviewEnabled: boolean;
  onReview: (review: SignedReview) => Promise<boolean>;
}) {
  const { receipt, review } = attempt;
  return <article className={styles.attempt}>
    <div className={styles.attemptHeader}>
      <h4>{jobLabel} · {nodeLabel}</h4>
      <span className={styles.note}>{sourceLabels[attempt.sourceState]}</span>
    </div>
    <dl className={styles.facts}>
      <dt>主机状态</dt><dd>{executionLabels[attempt.executionState]}</dd>
      <dt>执行记录</dt><dd><code>{attempt.id}</code></dd>
      {attempt.workerTaskId && <><dt>主机任务</dt><dd><code>{attempt.workerTaskId}</code></dd></>}
      {receipt?.materials && <><dt>材料工作区</dt><dd><code>{receipt.materials.observed.workspace.id}</code> · 已核对材料字节</dd></>}
    </dl>
    {receipt ? <ExecutionReceipt key={receipt.sha256} receipt={receipt} reviewable={reviewable && review?.state !== "current"} reviewEnabled={reviewEnabled} onReview={onReview} /> : <p className={styles.note}>未取得执行回执。</p>}
    <div className={styles.review}>
      <p>{!review ? "未提供签名复核" : (fresh && review.state === "current" && attempt.sourceState === "current" ? "签名复核" : "历史签名复核已过期 · ") + (review.verdict === "passed" ? "通过" : "未通过")}</p>
      {review && <>
        <p className={styles.note}>签名与回执关联已验证；系统未验证签名者与执行者是否为不同的人。</p>
        <p className={styles.note}>{review.reviewerId} · <time dateTime={review.reviewedAt}>{review.reviewedAt}</time></p>
        <p className={styles.summary}>{review.summary}</p>
      </>}
    </div>
  </article>;
}

function ExecutionReceipt({ receipt, reviewable, reviewEnabled, onReview }: {
  receipt: NativeExecutionReceipt;
  reviewable: boolean;
  reviewEnabled: boolean;
  onReview: (review: SignedReview) => Promise<boolean>;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [raw, setRaw] = useState("");
  const [invalid, setInvalid] = useState("");
  const json = JSON.stringify(receipt, null, 2);

  async function copy() {
    try {
      await navigator.clipboard.writeText(json);
      setCopyStatus("已复制回执");
    } catch {
      setCopyStatus("复制不可用，请展开回执 JSON 后手动复制。");
    }
  }

  async function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!reviewable || !reviewEnabled) return;
    setInvalid("");
    let signed: SignedReview;
    try {
      signed = decodeSignedReview(raw, receipt);
    } catch (error) {
      setInvalid(error instanceof SyntaxError ? "签名复核不是有效 JSON" : (error as Error).message);
      return;
    }
    if (await onReview(signed)) setRaw("");
  }

  return <div className={styles.receipt}>
    <dl className={styles.facts}>
      <dt>回执 SHA-256</dt><dd><code>{receipt.sha256}</code></dd>
      <dt>退出码</dt><dd>{receipt.exitCode}</dd>
      <dt>标准输出</dt><dd>{receipt.stdout.bytes} 字节 <code>{receipt.stdout.sha256}</code></dd>
      <dt>标准错误</dt><dd>{receipt.stderr.bytes} 字节 <code>{receipt.stderr.sha256}</code></dd>
      {receipt.materials && <><dt>材料回执</dt><dd>v2 · 适配器读取并核对固定材料</dd></>}
    </dl>
    {receipt.materials && <details className={styles.materialDetails}>
      <summary>查看固定材料摘要（{receipt.materials.observed.artifacts.length} 件产物）</summary>
      <dl className={styles.facts}>
        <dt>任务来源</dt><dd>revision {receipt.materials.expected.source.revision} · <code>{receipt.materials.expected.source.digest}</code></dd>
        {(["code", "input", "runtime", "config"] as const).map(kind => {
          const observed = receipt.materials!.observed[kind];
          const label = kind === "code" ? "代码" : kind === "input" ? "输入" : kind === "runtime" ? "运行时文件" : "配置";
          return <Fragment key={kind}>
            <dt>{label}</dt><dd><code>{observed.path}</code> · <code>{observed.digest}</code></dd>
          </Fragment>;
        })}
        {receipt.materials.observed.artifacts.map(item => <Fragment key={item.path}>
          <dt>产物 · {item.bytes} 字节</dt><dd><code>{item.path}</code> · <code>{item.digest}</code></dd>
        </Fragment>)}
      </dl>
    </details>}
    <div className={styles.receiptActions}>
      <button type="button" onClick={() => void copy()}>复制回执供复核</button>
      <details><summary>查看回执 JSON</summary><pre>{json}</pre></details>
    </div>
    {copyStatus && <p className={styles.note} role="status">{copyStatus}</p>}
    {reviewable && <details className={styles.reviewImport}>
      <summary>导入签名复核</summary>
      <form onSubmit={event => void review(event)}>
        <label>签名复核 JSON<textarea value={raw} onChange={event => { setRaw(event.target.value); setInvalid(""); }} rows={4} maxLength={16384} spellCheck={false} autoComplete="off" /></label>
        {invalid && <p role="alert">{invalid}</p>}
        <button type="submit" disabled={!reviewEnabled || !raw.trim()}>提交复核</button>
      </form>
    </details>}
  </div>;
}
