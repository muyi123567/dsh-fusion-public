import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RoomRecord } from "@dsh-fusion/core";
import { RoomWorkspace } from "./RoomWorkspace.js";

const room: RoomRecord = {
  id: "agent-room:room-1",
  providerId: "agent-room",
  name: "Release Room",
  topic: "Coordinate release",
  status: "open",
  leaderSessionId: "leader-session",
  memberIds: ["agent-room:room-1:lead", "agent-room:room-1:reviewer"],
  activityCount: 1,
  activity: [{
    id: "event-1",
    type: "message.direct",
    at: "2026-10-21T00:00:00.000Z",
    label: "Message accepted for Reviewer",
  }],
  conversation: {
    messages: [{
      id: "message-1",
      at: "2026-10-21T00:01:00.000Z",
      role: "leader",
      authorMemberId: "lead",
      authorName: "Release Lead",
      recipientMemberIds: ["reviewer"],
      text: "Please verify the release",
      status: "accepted",
      mode: "direct",
    }],
    unavailableMemberIds: [],
    hiddenMixedReplyCount: 0,
  },
};

describe("RoomWorkspace", () => {
  it("renders the real Room conversation projection", () => {
    render(<RoomWorkspace rooms={[room]} />);

    expect(screen.getAllByText("Release Room").length).toBeGreaterThan(0);
    expect(screen.getByText("Release Lead")).toBeInTheDocument();
    expect(screen.getByText("Please verify the release")).toBeInTheDocument();
    expect(screen.getByText(/投递给 reviewer/)).toBeInTheDocument();
  });

  it("does not invent a timeline when the upstream omits it", () => {
    const withoutTimeline: RoomRecord = {
      ...room,
      id: "agent-room:room-empty",
      activityCount: 0,
    };
    delete withoutTimeline.activity;
    delete withoutTimeline.conversation;
    render(<RoomWorkspace rooms={[withoutTimeline]} />);

    expect(screen.getByText("当前 Room 版本没有暴露消息正文或活动 timeline。")).toBeInTheDocument();
  });

  it("issues quoted Room commands through the DSH session service", async () => {
    const onCommand = vi.fn(async () => {});
    render(<RoomWorkspace rooms={[room]} onCommand={onCommand} />);

    await userEvent.type(screen.getByLabelText("Room 名称"), "Ship It");
    await userEvent.type(screen.getByLabelText("Room 主题"), "Release check");
    await userEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onCommand).toHaveBeenLastCalledWith(
      '/room create --name "Ship It" --topic "Release check"',
    );

    await userEvent.selectOptions(
      screen.getByLabelText("消息目标成员"),
      "agent-room:room-1:reviewer",
    );
    await userEvent.type(screen.getByLabelText("直发消息"), 'Check "quotes"');
    await userEvent.click(screen.getByRole("button", { name: "发送" }));
    expect(onCommand).toHaveBeenLastCalledWith(
      '/room send "room-1" "reviewer" --message "Check \\"quotes\\""',
    );
  });

  it("disables Room writes when no DSH session command service is available", () => {
    render(<RoomWorkspace rooms={[room]} />);
    expect(screen.getByText("Room 写操作需要 DSH Session 命令服务。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "发送" })).toBeDisabled();
  });
});
