import type { TaskRecord } from "@dsh-fusion/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { buildWhalePanelModel } from "../whale/model.js";
import { NativeTaskExecution } from "./NativeTaskExecution.js";

const task: TaskRecord = {
  id: "dsh-native-team:team%3A1:task%3A2", goal: "核对构建", status: "queued", transport: "dsh-fleet",
  targetNodeIds: [], evidence: [], createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-20T00:00:00Z",
  agentTeamTask: { teamId: "team:1", taskId: "task:2", revision: 1, blockedBy: [], writeScopes: [] },
};
const dataFor = (selected = task, demo = false) => ({
  model: buildWhalePanelModel({ tasks: [selected], nodes: [], demo, loaded: true, stale: false }),
  tasks: [selected], nodes: [], teams: [], loaded: true,
});
const executionPath = "plugins/dsh-fusion/tasks/execution";
const list = { taskAvailable: true, sourceToken: "1".repeat(64), attempts: [], jobs: [
  { id: "validate", label: "构建校验", nodeIds: ["worker-a", "worker-b"] },
] };
const receipt = {
  sha256: "a".repeat(64), taskId: task.id, sourceToken: list.sourceToken, attemptId: "attempt-one",
  jobId: "validate", nodeId: "worker-b", workerTaskId: "worker-job", commandSha256: "b".repeat(64),
  dispatchFingerprint: "c".repeat(64), startedAt: "2026-11-20T00:00:10Z", finishedAt: "2026-11-20T00:00:12Z",
  exitCode: 0, stdout: { sha256: "d".repeat(64), bytes: 11 }, stderr: { sha256: "e".repeat(64), bytes: 0 },
};
const attempt = {
  id: receipt.attemptId, taskId: task.id, sourceToken: list.sourceToken, jobId: "validate", nodeId: "worker-b",
  requestId: "request-one", workerTaskId: "worker-job", createdAt: "2026-11-20T00:00:09Z",
  sourceState: "current", executionState: "exited", receipt,
};
const result = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const getUrl = (id: string) => `${executionPath}?taskId=${encodeURIComponent(id)}`;

afterEach(() => vi.unstubAllGlobals());

it("leaves the execution route untouched for demo data, plain tasks, and native tasks without a revision", () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<NativeTaskExecution task={task} data={dataFor(task, true)} />);
  const plain = { ...task, id: "normal-task" };
  rerender(<NativeTaskExecution task={plain} data={dataFor(plain)} />);
  const { agentTeamTask: _, ...revisionless } = task;
  rerender(<NativeTaskExecution task={revisionless} data={dataFor(revisionless)} />);
  expect(fetcher).not.toHaveBeenCalled();
});

it("keeps disabled execution out of task details and allows retry on a genuine read failure", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(result({}, 503)).mockResolvedValueOnce(result({}, 404));
  vi.stubGlobal("fetch", fetcher);
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "刷新执行状态" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "任务执行" })).toBeNull());
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([getUrl(task.id), getUrl(task.id)]);
});

it("posts only the selected configured worker and reconciles the accepted attempt by reading", async () => {
  let finishRead!: (response: Response) => void;
  const laterRead = new Promise<Response>(resolve => { finishRead = resolve; });
  const fetcher = vi.fn().mockResolvedValueOnce(result(list)).mockImplementationOnce((_, init: RequestInit) => {
    const { requestId } = JSON.parse(String(init.body));
    return result({ ...attempt, requestId, executionState: "running", receipt: undefined }, 202);
  }).mockReturnValueOnce(laterRead);
  vi.stubGlobal("fetch", fetcher);
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  fireEvent.change(await screen.findByLabelText("执行作业"), { target: { value: "validate" } });
  fireEvent.change(screen.getByLabelText("执行主机"), { target: { value: "worker-b" } });
  fireEvent.click(screen.getByRole("button", { name: "启动执行" }));
  const runningState = await screen.findByText("运行中");
  expect(runningState).toBeVisible();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([getUrl(task.id), executionPath, getUrl(task.id)]);
  const request = JSON.parse(fetcher.mock.calls[1]?.[1].body);
  expect(request).toEqual({ taskId: task.id, sourceToken: list.sourceToken, jobId: "validate", nodeId: "worker-b", requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) });
  finishRead(result({ ...list, attempts: [{ ...attempt, requestId: request.requestId }] }));
  expect(await screen.findByText("回执 SHA-256")).toBeVisible();
  expect(screen.getByText(receipt.sha256)).toBeVisible();
  expect(screen.getByText(receipt.stdout.sha256)).toBeVisible();
  expect(screen.getByText(receipt.stderr.sha256)).toBeVisible();
  expect(screen.getByText("未提供签名复核")).toBeVisible();
});

it("after an uncertain POST only reads until the exact request is found", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(result(list)).mockRejectedValueOnce(new Error("lost response"))
    .mockResolvedValueOnce(result({ ...list, attempts: [attempt] }));
  vi.stubGlobal("fetch", fetcher);
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  fireEvent.change(await screen.findByLabelText("执行作业"), { target: { value: "validate" } });
  fireEvent.change(screen.getByLabelText("执行主机"), { target: { value: "worker-b" } });
  fireEvent.click(screen.getByRole("button", { name: "启动执行" }));
  await screen.findByText(/提交结果尚未确认/);
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
  expect(screen.getByRole("button", { name: "启动执行" })).toBeDisabled();
  const request = JSON.parse(fetcher.mock.calls[1]?.[1].body);
  fetcher.mockResolvedValueOnce(result({ ...list, attempts: [{ ...attempt, requestId: request.requestId }] }));
  fireEvent.click(screen.getByRole("button", { name: "刷新执行状态" }));
  await waitFor(() => expect(screen.queryByText(/提交结果尚未确认/)).toBeNull());
  expect(screen.getByRole("button", { name: "启动执行" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("执行主机"), { target: { value: "worker-a" } });
  expect(screen.getByRole("button", { name: "启动执行" })).toBeEnabled();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([getUrl(task.id), executionPath, getUrl(task.id), getUrl(task.id)]);
});

it("shows the environment gate and the environment-bound receipt", async () => {
  const digest = `sha256:${"f".repeat(64)}`;
  const environment = {
    hostId: digest, expectedDigest: digest, observedDigest: digest, policy: "exact" as const,
    matched: true, checkedAt: "2026-11-20T00:00:09Z", source: "controller-gate" as const,
  };
  const withEnvironment = {
    ...attempt, environment,
    receipt: { ...receipt, environment, sha256: "f".repeat(64) },
  };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(result({ ...list, attempts: [withEnvironment] })));
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  expect(await screen.findByText("环境门禁")).toBeVisible();
  expect(screen.getByText("环境绑定")).toBeVisible();
  expect(screen.getAllByText(digest).length).toBeGreaterThan(0);
});

it("loads the local environment and sends it as a dispatch requirement", async () => {
  const digest = `sha256:${"a".repeat(64)}`;
  let requestId = "";
  const fetcher = vi.fn()
    .mockResolvedValueOnce(result(list))
    .mockResolvedValueOnce(result({ hostId: digest, environmentDigest: digest }))
    .mockImplementationOnce((_, init: RequestInit) => {
      requestId = JSON.parse(String(init.body)).requestId;
      return result({ ...attempt, requestId, executionState: "running", receipt: undefined }, 202);
    })
    .mockImplementationOnce(() => result({ ...list, attempts: [{ ...attempt, requestId }] }));
  vi.stubGlobal("fetch", fetcher);
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  fireEvent.change(await screen.findByLabelText("执行作业"), { target: { value: "validate" } });
  fireEvent.change(screen.getByLabelText("执行主机"), { target: { value: "worker-b" } });
  fireEvent.click(screen.getByRole("button", { name: "读取本机环境" }));
  await waitFor(() => expect(screen.getByLabelText("期望环境摘要")).toHaveValue(digest));
  fireEvent.click(screen.getByRole("button", { name: "启动执行" }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
  const request = JSON.parse(fetcher.mock.calls[2]?.[1].body);
  expect(request.environment).toEqual({ hostId: digest, requireDigest: digest, policy: "exact" });
});

it("discards prior launch controls when the displayed subject changes before the next read settles", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(result(list)).mockReturnValueOnce(new Promise(() => {}));
  vi.stubGlobal("fetch", fetcher);
  const { rerender } = render(<NativeTaskExecution task={task} data={dataFor()} />);
  fireEvent.change(await screen.findByLabelText("执行作业"), { target: { value: "validate" } });
  fireEvent.change(screen.getByLabelText("执行主机"), { target: { value: "worker-b" } });
  expect(screen.getByRole("button", { name: "启动执行" })).toBeEnabled();
  const newTask = { ...task, goal: "核对新版构建" };
  rerender(<NativeTaskExecution task={newTask} data={dataFor(newTask)} />);
  expect(screen.queryByRole("button", { name: "启动执行" })).toBeNull();
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
});

it.each([{ sourceRevision: 2 }, { sourceGoal: "另一标题" }, { sourceDescription: "另一说明" }])(
  "does not act when the execution source differs from the displayed task (%j)", async source => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result({ ...list, ...source })));
    render(<NativeTaskExecution task={task} data={dataFor()} />);
    expect(await screen.findByText(/任务来源已更新/)).toBeVisible();
    expect(screen.getByLabelText("执行作业")).toBeDisabled();
    expect(screen.getByRole("button", { name: "启动执行" })).toBeDisabled();
  });

it("keeps completed native tasks visible but disables a new execution", async () => {
  const completed = { ...task, status: "completed" as const };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result(list)));
  render(<NativeTaskExecution task={completed} data={dataFor(completed)} />);
  expect(await screen.findByText("任务已结束，不能重新执行，暂不可操作。")).toBeVisible();
  expect(screen.getByRole("button", { name: "启动执行" })).toBeDisabled();
});

it("shows a read error instead of rendering a malformed execution receipt", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result({ ...list, attempts: [{ ...attempt, receipt: {} }] })));
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("无法读取执行状态");
  expect(screen.queryByRole("button", { name: "启动执行" })).toBeNull();
});

it("keeps a historical verdict visible when the worker receipt is no longer available", async () => {
  const historical = { ...attempt, receipt: undefined, executionState: "unconfirmed", sourceState: "stale", review: {
    reviewerId: "reviewer-independent", verdict: "passed", summary: "旧修订产物一致", state: "stale",
    reviewedAt: "2026-11-20T00:01:00Z", receiptSha256: receipt.sha256,
  } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(result({ ...list, attempts: [historical] })));
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  expect(await screen.findByText("历史签名复核已过期 · 通过")).toBeVisible();
  expect(screen.getByText("未取得执行回执。")).toBeVisible();
  expect(screen.queryByText("导入签名复核")).toBeNull();
});

it("submits only signed review JSON that matches the receipt being reviewed", async () => {
  const signed = { taskId: task.id, attemptId: attempt.id, receiptSha256: receipt.sha256, reviewerId: "reviewer-independent", verdict: "passed", summary: "核对产物一致", signature: "signed-review-fixture" };
  const review = { reviewerId: signed.reviewerId, verdict: signed.verdict, summary: signed.summary, state: "current", reviewedAt: "2026-11-20T00:01:00Z", receiptSha256: receipt.sha256 };
  const fetcher = vi.fn().mockResolvedValueOnce(result({ ...list, attempts: [attempt] }))
    .mockResolvedValueOnce(result({ attempt: { ...attempt, review } })).mockResolvedValueOnce(result({ ...list, attempts: [{ ...attempt, review }] }));
  vi.stubGlobal("fetch", fetcher);
  render(<NativeTaskExecution task={task} data={dataFor()} />);
  expect(await screen.findByText("未提供签名复核")).toBeVisible();
  fireEvent.click(screen.getByText("导入签名复核"));
  const input = screen.getByLabelText("签名复核 JSON");
  fireEvent.change(input, { target: { value: JSON.stringify({ ...signed, receiptSha256: "f".repeat(64) }) } });
  fireEvent.click(screen.getByRole("button", { name: "提交复核" }));
  await screen.findByText(/不匹配/);
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: JSON.stringify(signed) } });
  fireEvent.click(screen.getByRole("button", { name: "提交复核" }));
  expect(await screen.findByText("签名复核通过")).toBeVisible();
  expect(screen.getByText("签名与回执关联已验证；系统未验证签名者与执行者是否为不同的人。"))
    .toBeVisible();
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([getUrl(task.id), `${executionPath}/review`, getUrl(task.id)]);
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual(signed);
});
