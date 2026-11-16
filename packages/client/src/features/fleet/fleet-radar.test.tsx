import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FleetRadar } from "./FleetRadar.js";

describe("FleetRadar checks", () => {
  it("disables a check without a real callback and explains why", () => {
    render(<FleetRadar nodes={[]} selectedNodeId="" onSelectNode={vi.fn()} />);
    expect(screen.getByRole("button", { name: "配置检查" })).toBeDisabled();
    expect(screen.getByText("配置检查不可用：未连接检查服务")).toBeInTheDocument();
  });

  it("waits for the real check, prevents duplicates and exposes a later failure", async () => {
    let resolve!: () => void;
    const onCheck = vi.fn(() => new Promise<void>((done) => { resolve = done; }));
    const { rerender } = render(<FleetRadar nodes={[]} selectedNodeId="" onSelectNode={vi.fn()} onCheck={onCheck} />);
    fireEvent.click(screen.getByRole("button", { name: "配置检查" }));
    fireEvent.click(screen.getByRole("button", { name: "检查中…" }));
    expect(onCheck).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/刚刚检查/)).not.toBeInTheDocument();
    await act(async () => { resolve(); });
    expect(screen.getByText(/刚刚检查/)).toBeInTheDocument();
    rerender(<FleetRadar nodes={[]} selectedNodeId="" onSelectNode={vi.fn()} onCheck={vi.fn().mockRejectedValue(new Error("doctor unavailable"))} />);
    fireEvent.click(screen.getByRole("button", { name: "配置检查" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("doctor unavailable");
    expect(screen.queryByText(/刚刚检查/)).not.toBeInTheDocument();
  });

  it("presents fleet observability and omits it when the block is absent", () => {
    const fleet = {
      checkedAt: new Date(2026, 10, 3, 14, 3, 22).getTime(),
      stale: true,
      inspect: {
        totals: { attempts: 9, failures: 2 },
        lastRound: {
          round: 3,
          attempts: 5,
          failures: 2,
          peakQueueDepth: 3,
          startedAt: 0,
          durationMs: 45,
        },
      },
    };
    const { rerender } = render(
      <FleetRadar nodes={[]} selectedNodeId="" onSelectNode={vi.fn()} fleet={fleet} />,
    );
    expect(screen.getByText(/数据时间 14:03:22/)).toBeInTheDocument();
    expect(screen.getByText(/快照已过期/)).toBeInTheDocument();
    expect(screen.getByText(/巡检累计 9 次 · 失败 2 次/)).toBeInTheDocument();
    expect(screen.getByText(/最近一轮 5 次 · 失败 2 次 · 队列峰值 3 · 耗时 45 ms/)).toBeInTheDocument();

    rerender(<FleetRadar nodes={[]} selectedNodeId="" onSelectNode={vi.fn()} />);
    expect(screen.queryByText(/数据时间/)).not.toBeInTheDocument();
    expect(screen.queryByText(/快照已过期/)).not.toBeInTheDocument();
  });

  it("turns an empty fleet into a direct setup action", async () => {
    const onOpenSetup = vi.fn();
    render(
      <FleetRadar
        nodes={[]}
        selectedNodeId=""
        onSelectNode={vi.fn()}
        onOpenSetup={onOpenSetup}
      />,
    );

    expect(screen.getByText("还没有可观测的执行节点")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "添加执行节点" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });
});
