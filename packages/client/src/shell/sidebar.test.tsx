import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FusionApp } from "../app.js";
import { Sidebar } from "./Sidebar.js";

describe("Fusion shell navigation", () => {
  it("switches from bot workspace to fleet without losing the selected node", async () => {
    render(<FusionApp initialMode="bot" />);
    await userEvent.click(screen.getByRole("button", { name: "节点" }));
    expect(screen.getByText("舰队雷达")).toBeInTheDocument();
    expect(screen.getAllByText("腾讯 Worker").length).toBeGreaterThan(0);
  });

  it("explains the capability condition when adding a session", async () => {
    render(
      <Sidebar
        mode="bot"
        onModeChange={vi.fn()}
        bots={[]}
        groups={[]}
        nodes={[]}
        sessions={[]}
        selectedBotId=""
        onSelectBot={vi.fn()}
        onSelectNode={vi.fn()}
        onSelectSession={vi.fn()}
        mobileOpen={false}
        onCloseMobile={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "添加会话" }));
    expect(screen.getByText("添加会话需要实时 Session provider")).toBeInTheDocument();
  });

  it("opens the setup readiness workspace from navigation", async () => {
    render(<FusionApp initialMode="bot" />);

    await userEvent.click(screen.getByRole("button", { name: "开箱检查" }));

    expect(screen.getByRole("heading", { name: "开箱检查" })).toBeInTheDocument();
    expect(screen.getByText("基础项就绪")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "打开详情" })).not.toBeInTheDocument();
  });
});
