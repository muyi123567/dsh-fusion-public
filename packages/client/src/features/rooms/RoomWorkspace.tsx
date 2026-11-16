import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Hash,
  Link2,
  MessagesSquare,
  Plus,
  Radio,
  Send,
  UserMinus,
  UsersRound,
  X,
} from "lucide-react";
import type { RoomRecord } from "@dsh-fusion/core";

function quoteRoomArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function upstreamRoomId(roomId: string): string {
  return roomId.startsWith("agent-room:") ? roomId.slice("agent-room:".length) : roomId;
}

function upstreamMemberId(memberId: string): string {
  return memberId.split(":").at(-1) ?? memberId;
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

export function RoomWorkspace({
  rooms,
  selectedRoomId,
  onSelectRoom,
  onCommand,
}: {
  rooms: RoomRecord[];
  selectedRoomId?: string;
  onSelectRoom?: (roomId: string) => void;
  onCommand?: (input: string) => Promise<void>;
}) {
  const [localRoomId, setLocalRoomId] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [createName, setCreateName] = useState("");
  const [createTopic, setCreateTopic] = useState("");
  const [attachSessionId, setAttachSessionId] = useState("");
  const [attachName, setAttachName] = useState("");
  const [messageTarget, setMessageTarget] = useState("");
  const [messageText, setMessageText] = useState("");
  const [broadcastText, setBroadcastText] = useState("");
  const [closeSummary, setCloseSummary] = useState("");
  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === (selectedRoomId ?? localRoomId)) ?? rooms[0],
    [localRoomId, rooms, selectedRoomId],
  );

  useEffect(() => {
    if (selectedRoom !== undefined && selectedRoom.id !== localRoomId) {
      setLocalRoomId(selectedRoom.id);
    }
  }, [localRoomId, selectedRoom]);

  const selectedMembers = useMemo(
    () => selectedRoom?.memberIds ?? [],
    [selectedRoom?.memberIds],
  );

  useEffect(() => {
    if (selectedMembers.length === 0) {
      setMessageTarget("");
      return;
    }
    if (!selectedMembers.includes(messageTarget)) {
      setMessageTarget(selectedMembers[0] ?? "");
    }
  }, [messageTarget, selectedMembers]);

  const run = async (label: string, command: string): Promise<boolean> => {
    if (onCommand === undefined) {
      setActionError("当前宿主没有可用的 DSH Session 命令服务");
      return false;
    }
    setBusy(label);
    setActionError(undefined);
    try {
      await onCommand(command);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const createRoom = async () => {
    if (createName.trim() === "") return;
    const command = [
      "/room create",
      "--name",
      quoteRoomArg(createName.trim()),
      ...(createTopic.trim() === "" ? [] : ["--topic", quoteRoomArg(createTopic.trim())]),
    ].join(" ");
    if (await run("create", command)) {
      setCreateName("");
      setCreateTopic("");
    }
  };

  const attachSession = async () => {
    if (selectedRoom === undefined || attachSessionId.trim() === "") return;
    const roomId = upstreamRoomId(selectedRoom.id);
    const command = [
      "/room attach",
      quoteRoomArg(roomId),
      "--session",
      quoteRoomArg(attachSessionId.trim()),
      ...(attachName.trim() === "" ? [] : ["--name", quoteRoomArg(attachName.trim())]),
    ].join(" ");
    if (await run("attach", command)) {
      setAttachSessionId("");
      setAttachName("");
    }
  };

  const sendMessage = async () => {
    if (
      selectedRoom === undefined
      || messageTarget === ""
      || messageText.trim() === ""
    ) return;
    const command = [
      "/room send",
      quoteRoomArg(upstreamRoomId(selectedRoom.id)),
      quoteRoomArg(upstreamMemberId(messageTarget)),
      "--message",
      quoteRoomArg(messageText.trim()),
    ].join(" ");
    if (await run("send", command)) setMessageText("");
  };

  const broadcast = async () => {
    if (selectedRoom === undefined || broadcastText.trim() === "") return;
    const command = [
      "/room broadcast",
      quoteRoomArg(upstreamRoomId(selectedRoom.id)),
      "--message",
      quoteRoomArg(broadcastText.trim()),
    ].join(" ");
    if (await run("broadcast", command)) setBroadcastText("");
  };

  const removeMember = async () => {
    if (selectedRoom === undefined || messageTarget === "") return;
    const command = [
      "/room remove",
      quoteRoomArg(upstreamRoomId(selectedRoom.id)),
      quoteRoomArg(upstreamMemberId(messageTarget)),
      "--interrupt",
      "false",
    ].join(" ");
    await run("remove", command);
  };

  const closeRoom = async () => {
    if (selectedRoom === undefined) return;
    const command = [
      "/room close",
      quoteRoomArg(upstreamRoomId(selectedRoom.id)),
      ...(closeSummary.trim() === "" ? [] : ["--summary", quoteRoomArg(closeSummary.trim())]),
      "--interrupt",
      "false",
    ].join(" ");
    if (await run("close", command)) setCloseSummary("");
  };

  return (
    <section className="fusion-page fusion-room-page">
      <div className="fusion-page-head">
        <div>
          <h1>会话房间</h1>
          <p>Room 成员、投递活动和 DSH Session conversation 投影。</p>
        </div>
        <span className="fusion-room-count"><MessagesSquare size={14} /> {rooms.length} 个房间</span>
      </div>

      <div className="fusion-room-actions">
        <div className="fusion-room-create">
          <strong><Plus size={14} /> 新建 Room</strong>
          <input
            aria-label="Room 名称"
            value={createName}
            placeholder="Room 名称"
            onChange={(event) => setCreateName(event.currentTarget.value)}
          />
          <input
            aria-label="Room 主题"
            value={createTopic}
            placeholder="主题（可选）"
            onChange={(event) => setCreateTopic(event.currentTarget.value)}
          />
          <button
            type="button"
            disabled={onCommand === undefined || busy !== undefined || createName.trim() === ""}
            onClick={() => void createRoom()}
          >
            {busy === "create" ? "创建中" : "创建"}
          </button>
        </div>

        {selectedRoom?.status === "open" ? (
          <div className="fusion-room-action-grid">
            <div>
              <strong><Link2 size={13} /> 挂接 Session</strong>
              <input
                aria-label="Child Session ID"
                value={attachSessionId}
                placeholder="Continuable child session id"
                onChange={(event) => setAttachSessionId(event.currentTarget.value)}
              />
              <input
                aria-label="成员名称"
                value={attachName}
                placeholder="成员名称（可选）"
                onChange={(event) => setAttachName(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={onCommand === undefined || busy !== undefined || attachSessionId.trim() === ""}
                onClick={() => void attachSession()}
              >
                挂接
              </button>
            </div>
            <div>
              <strong><Send size={13} /> 直发成员</strong>
              <select
                aria-label="消息目标成员"
                value={messageTarget}
                onChange={(event) => setMessageTarget(event.currentTarget.value)}
              >
                {selectedMembers.map((memberId) => (
                  <option key={memberId} value={memberId}>{upstreamMemberId(memberId)}</option>
                ))}
              </select>
              <input
                aria-label="直发消息"
                value={messageText}
                placeholder="发送给所选成员"
                onChange={(event) => setMessageText(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={onCommand === undefined || busy !== undefined || messageTarget === "" || messageText.trim() === ""}
                onClick={() => void sendMessage()}
              >
                发送
              </button>
              <button
                type="button"
                className="is-danger"
                disabled={onCommand === undefined || busy !== undefined || messageTarget === ""}
                onClick={() => void removeMember()}
              >
                <UserMinus size={13} /> 移除
              </button>
            </div>
            <div>
              <strong><Radio size={13} /> 广播与关闭</strong>
              <input
                aria-label="广播消息"
                value={broadcastText}
                placeholder="广播给所有成员"
                onChange={(event) => setBroadcastText(event.currentTarget.value)}
              />
              <button
                type="button"
                disabled={onCommand === undefined || busy !== undefined || broadcastText.trim() === ""}
                onClick={() => void broadcast()}
              >
                广播
              </button>
              <input
                aria-label="关闭摘要"
                value={closeSummary}
                placeholder="关闭摘要（可选）"
                onChange={(event) => setCloseSummary(event.currentTarget.value)}
              />
              <button
                type="button"
                className="is-danger"
                disabled={onCommand === undefined || busy !== undefined}
                onClick={() => void closeRoom()}
              >
                <X size={13} /> 关闭 Room
              </button>
            </div>
          </div>
        ) : null}
        {actionError === undefined ? null : (
          <p className="fusion-room-action-error" role="alert">{actionError}</p>
        )}
        {onCommand === undefined ? (
          <p className="fusion-room-action-note">Room 写操作需要 DSH Session 命令服务。</p>
        ) : null}
      </div>

      {rooms.length === 0 ? (
        <div className="fusion-room-empty">
          <MessagesSquare size={18} />
          <div>
            <strong>没有实时 Room 数据</strong>
            <small>安装并启用 Agent Team Room 后，这里会读取当前 Session 可见的房间。</small>
          </div>
        </div>
      ) : (
        <div className="fusion-room-layout">
          <aside className="fusion-room-list" aria-label="房间列表">
            {rooms.map((room) => (
              <button
                type="button"
                className={room.id === selectedRoom?.id ? "is-selected" : ""}
                key={room.id}
                onClick={() => {
                  setLocalRoomId(room.id);
                  onSelectRoom?.(room.id);
                }}
              >
                <span className={`fusion-room-state ${room.status}`} />
                <span>
                  <strong>{room.name}</strong>
                  <small>{room.topic ?? `${room.memberIds.length} 名成员`}</small>
                </span>
                <em>{room.activityCount}</em>
              </button>
            ))}
          </aside>

          {selectedRoom === undefined ? null : (
            <div className="fusion-room-thread">
              <header className="fusion-room-thread-head">
                <div>
                  <span className="fusion-room-hash"><Hash size={15} /></span>
                  <div>
                    <strong>{selectedRoom.name}</strong>
                    <small>{selectedRoom.topic ?? "当前 Session 的协作房间"}</small>
                  </div>
                </div>
                <span className={`fusion-room-status ${selectedRoom.status}`}>
                  {selectedRoom.status === "open" ? "开放" : "已关闭"}
                </span>
              </header>

              <div className="fusion-room-members">
                <UsersRound size={14} />
                {selectedRoom.memberIds.length === 0
                  ? <span>暂无成员</span>
                  : selectedRoom.memberIds.map((memberId) => (
                      <span key={memberId} title={memberId}>{memberId.split(":").at(-1)}</span>
                    ))}
              </div>

              <ol className="fusion-room-timeline" aria-label={`${selectedRoom.name} 时间线`}>
                {selectedRoom.conversation?.messages.map((message) => (
                  <li key={message.id} className={`fusion-room-message ${message.role}`}>
                    <span className="fusion-room-message-icon">
                      {message.status === "completed" ? <CheckCircle2 size={14} /> : <Clock3 size={14} />}
                    </span>
                    <div>
                      <header>
                        <strong>{message.authorName}</strong>
                        <small>{formatTime(message.at)}</small>
                        {message.mode === undefined ? null : <em>{message.mode}</em>}
                      </header>
                      <p>{message.text}</p>
                      {message.recipientMemberIds.length === 0 ? null : (
                        <small className="fusion-room-recipients">
                          投递给 {message.recipientMemberIds.map((memberId) => memberId.split(":").at(-1)).join("、")}
                        </small>
                      )}
                    </div>
                  </li>
                ))}

                {(selectedRoom.conversation?.messages.length ?? 0) === 0
                  ? (selectedRoom.activity ?? []).map((activity) => (
                      <li key={activity.id} className="fusion-room-activity">
                        <span className="fusion-room-message-icon">
                          {activity.failedCount !== undefined && activity.failedCount > 0
                            ? <CircleAlert size={14} />
                            : <Clock3 size={14} />}
                        </span>
                        <div>
                          <header>
                            <strong>{activity.label}</strong>
                            <small>{formatTime(activity.at)}</small>
                          </header>
                          <p>{activity.type}</p>
                        </div>
                      </li>
                    ))
                  : null}

                {(selectedRoom.conversation?.messages.length ?? 0) === 0
                  && (selectedRoom.activity?.length ?? 0) === 0 ? (
                  <li className="fusion-room-timeline-empty">
                    <MessagesSquare size={16} />
                    <span>当前 Room 版本没有暴露消息正文或活动 timeline。</span>
                  </li>
                ) : null}
              </ol>

              {(selectedRoom.conversation?.unavailableMemberIds.length ?? 0) > 0 ? (
                <p className="fusion-room-warning">
                  {selectedRoom.conversation?.unavailableMemberIds.length} 名成员的 Session 历史不可读，时间线可能不完整。
                </p>
              ) : null}
              {(selectedRoom.conversation?.hiddenMixedReplyCount ?? 0) > 0 ? (
                <p className="fusion-room-warning">
                  {selectedRoom.conversation?.hiddenMixedReplyCount} 条混合回复被 Room provider 隐藏，时间线可能不完整。
                </p>
              ) : null}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
