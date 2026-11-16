import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildExecutionPreview, type ExecutionPreview, type ExecutionPreviewNode, type NodeRecord } from "@dsh-fusion/core";
import { DispatchPreview } from "./DispatchPreview.js";

const now = Date.parse("2026-10-30T00:00:00Z");

function node(decision: ExecutionPreviewNode["decision"] = "eligible"): ExecutionPreviewNode {
  return {
    nodeId: "node-a", name: "节点 A", decision, reasonCodes: [],
    observation: {
      nodeId: "node-a", providerId: "ssh", state: "supported", checkedAt: now,
      expiresAt: now + 30_000, source: "ssh-readonly-probe", reasonCodes: [],
      checks: [{ id: "shell", ok: true }],
    },
  };
}

function preview(nodes: ExecutionPreviewNode[] = [node()]): ExecutionPreview {
  return {
    version: 1, checkedAt: now, expiresAt: now + 30_000,
    selectedNodeIds: nodes.map((item) => item.nodeId), ready: nodes.length > 0 && nodes.every((item) => item.decision === "eligible"),
    scope: "infrastructure-only", businessRequirements: "unverified", nodes,
  };
}

describe("DispatchPreview", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
  afterEach(() => { vi.useRealTimers(); });

  it.each([
    ["eligible", "基础检查可用"], ["blocked", "基础检查受阻"], ["unknown", "基础检查未知"],
  ] as const)("renders %s as a limited infrastructure decision", (decision, label) => {
    render(<DispatchPreview preview={preview([node(decision)])} />);
    expect(within(screen.getByRole("article", { name: "节点 A" })).getByText(label)).toBeInTheDocument();
    expect(screen.getByText("业务要求：未验证")).toBeInTheDocument();
    expect(screen.getByText("只读诊断，不代表任务或目标已通过")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the whole group as unready when any selected node is unknown", () => {
    const withoutObservation: ExecutionPreviewNode = {
      nodeId: "node-b", name: "节点 B", decision: "unknown", reasonCodes: ["PROBE_UNAVAILABLE"],
    };
    render(<DispatchPreview preview={preview([node(), withoutObservation])} />);
    expect(screen.getByText("全组基础检查：未就绪")).toBeInTheDocument();
    expect(screen.getByText(/尚无能力观察/)).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "节点 B" })).getByText("观察来源：未提供")).toBeInTheDocument();
  });

  it("shows ready without claiming business validation and exposes observation provenance and times", () => {
    const { container } = render(<DispatchPreview preview={preview()} />);
    expect(screen.getByText("全组基础检查：就绪")).toBeInTheDocument();
    expect(screen.getByText("观察来源：ssh-readonly-probe")).toBeInTheDocument();
    expect(screen.getByText("提供方：ssh")).toBeInTheDocument();
    const timestamps = Array.from(container.querySelectorAll("time")).map((item) => item.dateTime);
    expect(timestamps).toContain(new Date(now).toISOString());
    expect(timestamps).toContain(new Date(now + 30_000).toISOString());
    expect(screen.getByText("业务要求：未验证")).toBeInTheDocument();
  });

  it("does not show an expired preview as ready even if its stored decision was eligible", () => {
    render(<DispatchPreview preview={{ ...preview(), expiresAt: now }} />);
    expect(screen.getByText("全组基础检查：未就绪")).toBeInTheDocument();
    expect(screen.getByText("基础检查未知")).toBeInTheDocument();
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThan(0);
    expect(screen.queryByText("基础检查可用")).not.toBeInTheDocument();
  });

  it("downgrades an expired observation while the overall preview remains in date", () => {
    const item = node();
    item.observation = { ...item.observation!, expiresAt: now - 1 };
    render(<DispatchPreview preview={preview([item])} />);
    expect(screen.getByText("基础检查未知")).toBeInTheDocument();
    expect(screen.getByText("全组基础检查：未就绪")).toBeInTheDocument();
  });

  it("stops showing eligibility when the observation expires while mounted", () => {
    const item = node();
    item.observation = { ...item.observation!, expiresAt: now + 1_000 };
    render(<DispatchPreview preview={preview([item])} />);
    expect(screen.getByText("全组基础检查：就绪")).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByText("全组基础检查：未就绪")).toBeInTheDocument();
    expect(screen.queryByText("基础检查可用")).not.toBeInTheDocument();
  });

  it("retains unfamiliar reason codes with an explicit readable fallback", () => {
    render(<DispatchPreview preview={preview([{ ...node("blocked"), reasonCodes: ["NODE_OFFLINE", "future_reason"] }])} />);
    expect(screen.getByText(/节点离线/)).toBeInTheDocument();
    expect(screen.getByText(/未识别的原因/)).toHaveTextContent("future_reason");
  });

  it("does not present an empty target set as ready", () => {
    render(<DispatchPreview preview={{ ...preview([]), ready: true }} />);
    expect(screen.getByText("尚未选择目标节点")).toBeInTheDocument();
    expect(screen.getByText("全组基础检查：未就绪")).toBeInTheDocument();
  });

  it("keeps a known blocking reason when a group diagnostic expires", () => {
    render(<DispatchPreview preview={{
      ...preview([{ ...node("blocked"), reasonCodes: ["NODE_OFFLINE"] }]), expiresAt: now,
    }} />);
    expect(screen.getByText("基础检查受阻")).toBeInTheDocument();
    expect(screen.getByText(/节点离线/)).toBeInTheDocument();
    expect(screen.getAllByText(/已过期/).length).toBeGreaterThan(0);
  });

  it.each([
    ["EXEC_PROBE_INVALID", "诊断结果不完整或格式异常"],
    ["EXEC_PROC_UNAVAILABLE", "无法读取进程信息"],
    ["EXEC_JOB_ROOT_UNWRITABLE", "任务目录的父目录权限不满足要求"],
    ["EXEC_TOOL_MISSING", "缺少执行所需工具"],
    ["PROBE_FAILED", "基础检查未能取得确定结果"],
    ["EXEC_PROBE_FAILED", "基础检查未能取得确定结果"],
  ])("explains the provider reason %s in Chinese", (code, label) => {
    render(<DispatchPreview preview={preview([{ ...node("unknown"), reasonCodes: [code] }])} />);
    expect(screen.getByText(new RegExp(label))).toBeInTheDocument();
    expect(screen.queryByText(/未识别的原因/)).not.toBeInTheDocument();
    expect(screen.getByText("基础检查未知")).toBeInTheDocument();
  });

  it("identifies only failed tool checks and keeps the full checklist collapsed by default", () => {
    const item = node("blocked");
    item.reasonCodes = ["EXEC_TOOL_MISSING"];
    item.observation = { ...item.observation!, state: "unsupported", checks: [
      { id: "tool_flock", ok: false }, { id: "tool_setsid", ok: true }, { id: "tool_bash", ok: false },
    ] };
    const { container } = render(<DispatchPreview preview={preview([item])} />);
    const missing = screen.getByText(/缺少工具：/);
    expect(missing).toHaveTextContent("tool_flock");
    expect(missing).toHaveTextContent("tool_bash");
    expect(missing).not.toHaveTextContent("tool_setsid");
    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    fireEvent.click(within(details).getByText(/查看基础检查项/));
    expect(details).toHaveAttribute("open");
    expect(within(details).getByText("工具：setsid").closest("li")).toHaveTextContent("满足");
    expect(within(details).getByText("工具：flock").closest("li")).toHaveTextContent("未满足");
  });

  it.each([true, false])("limits the job root check to parent directory permissions (ok=%s)", (ok) => {
    const item = node(ok ? "eligible" : "blocked");
    item.observation = { ...item.observation!, checks: [{ id: "job_root", ok }, { id: "proc", ok: true }] };
    const { container } = render(<DispatchPreview preview={preview([item])} />);
    const details = container.querySelector("details")!;
    fireEvent.click(within(details).getByText(/查看基础检查项/));
    expect(within(details).getByText("任务目录父目录权限")).toBeInTheDocument();
    expect(within(details).getByText("仅检查父目录权限，未实际创建任务目录。")).toBeInTheDocument();
    expect(within(details).getByText("进程信息读取")).toBeInTheDocument();
    expect(screen.queryByText(/任务目录已创建/)).not.toBeInTheDocument();
  });

  it("keeps unknown and blocked findings without observations visible during the diagnostic window", () => {
    const online: NodeRecord = {
      id: "node-a", externalId: "node-a", providerId: "ssh", name: "节点 A", platform: "linux",
      roles: ["worker"], status: "online", transports: ["ssh"], capabilities: [], configState: "unknown",
    };
    const result = buildExecutionPreview({
      nodes: [online, { ...online, id: "node-b", name: "节点 B", status: "offline" }],
      nodeIds: ["node-a", "node-b"], observations: [], now,
    });
    expect(result.expiresAt).toBe(now + 30_000);
    render(<DispatchPreview preview={result} />);
    act(() => { vi.advanceTimersByTime(29_000); });
    expect(within(screen.getByRole("article", { name: "节点 A" })).getByText(/尚无能力观察/)).toBeInTheDocument();
    expect(within(screen.getByRole("article", { name: "节点 B" })).getByText(/节点离线/)).toBeInTheDocument();
    expect(screen.getByText("全组基础检查：未就绪")).toBeInTheDocument();
    expect(screen.queryByText(/本组诊断已过期/)).not.toBeInTheDocument();
    expect(screen.queryByText("基础检查可用")).not.toBeInTheDocument();
  });

  it("marks an old observation per row without expiring the fresh negative diagnostic", () => {
    const observation = { ...node().observation!, checkedAt: now - 31_000, expiresAt: now - 1_000 };
    const online: NodeRecord = {
      id: "node-a", externalId: "node-a", providerId: "ssh", name: "节点 A", platform: "linux",
      roles: ["worker"], status: "online", transports: ["ssh"], capabilities: [], configState: "unknown",
    };
    const result = buildExecutionPreview({ nodes: [online], nodeIds: [online.id], observations: [observation], now });
    expect(result.expiresAt).toBe(now + 30_000);
    expect(result.nodes[0]?.decision).toBe("unknown");
    const { container } = render(<DispatchPreview preview={result} />);
    expect(screen.getByText("观察有效期至（已过期）")).toBeInTheDocument();
    expect(screen.getByText(/能力观察已过期/)).toBeInTheDocument();
    expect(screen.queryByText(/本组诊断已过期/)).not.toBeInTheDocument();
    expect(screen.queryByText("基础检查可用")).not.toBeInTheDocument();
    expect(container.querySelector(`time[datetime="${new Date(observation.expiresAt).toISOString()}"]`)).not.toBeNull();
    act(() => { vi.advanceTimersByTime(30_000); });
    expect(screen.getByText("有效期至（已过期）")).toBeInTheDocument();
    expect(screen.getByText("基础检查未知")).toBeInTheDocument();
  });
});
