import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BotRecord, SessionRecord, TaskRecord } from "@dsh-fusion/core";
import { BotWorkspace } from "./BotWorkspace.js";

const bot: BotRecord = {
  id: "bot-1",
  providerId: "agent-teams",
  name: "Captain",
  role: "Lead",
  model: "DeepSeek",
  isMain: true,
  status: "idle",
  memoryCount: 0,
  usageTokens: 0,
};

const session: SessionRecord = {
  id: "native-session-1",
  providerId: "agent-teams",
  botId: "bot-1",
  title: "Captain",
  status: "live",
  updatedAt: "2026-10-22T00:00:00.000Z",
};

describe("BotWorkspace", () => {
  it("opens its task in the unified execution view", async () => {
    const task: TaskRecord = { id: "bot-task", goal: "Bot execution", targetNodeIds: [], transport: "dsh-fleet", status: "failed", evidence: [], error: "provider refused", createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    const onOpenTask = vi.fn();
    render(<BotWorkspace bot={bot} tasks={[task]} nodes={[]} onOpenTask={onOpenTask} />);
    await userEvent.click(screen.getByRole("button", { name: "任务证据" }));
    expect(onOpenTask).toHaveBeenCalledWith(task.id);
  });

  it("keeps the draft across unmounts when the workspace owns it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messages: [], hasMore: false }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    function Harness() {
      const [drafts, setDrafts] = useState<Record<string, string>>({});
      const [show, setShow] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setShow((current) => !current)}>切换页面</button>
          {show ? (
            <BotWorkspace
              bot={bot}
              tasks={[]}
              nodes={[]}
              session={session}
              sessionHubUrl="https://hub.example.test/session-hub"
              draft={drafts[bot.id] ?? ""}
              onDraftChange={(draft) => setDrafts((current) => ({ ...current, [bot.id]: draft }))}
            />
          ) : null}
        </>
      );
    }
    render(<Harness />);
    await userEvent.type(screen.getByLabelText("发送消息"), "未发送的草稿");
    await userEvent.click(screen.getByRole("button", { name: "切换页面" }));
    await userEvent.click(screen.getByRole("button", { name: "切换页面" }));
    expect(screen.getByLabelText("发送消息")).toHaveValue("未发送的草稿");
  });

  it("disables the composer when the snapshot is stale or the session has ended", () => {
    const stale = render(
      <BotWorkspace bot={bot} tasks={[]} nodes={[]} session={session} sessionHubUrl="https://hub.example.test/session-hub" connectionStale />,
    );
    expect(screen.getByLabelText("发送消息")).toBeDisabled();
    stale.unmount();
    render(
      <BotWorkspace bot={bot} tasks={[]} nodes={[]} session={{ ...session, status: "finished" }} sessionHubUrl="https://hub.example.test/session-hub" />,
    );
    expect(screen.getByLabelText("发送消息")).toBeDisabled();
  });

  it("shows complete task failure details when no navigation callback is provided", async () => {
    const task: TaskRecord = { id: "bot-task", goal: "Bot execution", targetNodeIds: [], transport: "dsh-fleet", status: "failed", evidence: [], error: "provider refused", createdAt: "2026-10-23", updatedAt: "2026-10-23" };
    render(<BotWorkspace bot={bot} tasks={[task]} nodes={[]} />);
    await userEvent.click(screen.getByRole("button", { name: "任务证据" }));
    expect(screen.getByRole("region", { name: "任务详情" })).toHaveTextContent("provider refused");
  });
  it("sends a queue prompt through the mapped DSH Session", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") {
        return new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ messages: [], hasMore: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <BotWorkspace
        bot={bot}
        tasks={[]}
        nodes={[]}
        session={session}
        sessionHubUrl="/plugins/dsh-fusion/session-hub"
      />,
    );

    const composer = screen.getByLabelText("发送消息");
    expect(composer).not.toBeDisabled();
    await userEvent.type(composer, "请继续推进");
    await userEvent.click(screen.getByRole("button", { name: "发送" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "plugins/dsh-fusion/session-hub/prompt",
      expect.objectContaining({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceId: "agent-teams",
          sessionId: "native-session-1",
          text: "请继续推进",
          mode: "queue",
        }),
      }),
    );
    await waitFor(() => expect(composer).toHaveValue(""));
  });

  it("stays read-only when no native Session mapping exists", () => {
    render(<BotWorkspace bot={bot} tasks={[]} nodes={[]} />);
    expect(screen.getByLabelText("发送消息")).toBeDisabled();
    expect(screen.getByLabelText("发送消息")).toHaveAttribute(
      "placeholder",
      "当前没有可用的 Bot 发送适配器",
    );
  });
});
