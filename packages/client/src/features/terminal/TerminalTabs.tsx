import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Columns2, Plus, SquareTerminal, X } from "lucide-react";
import {
  PtyApiError,
  closeRemotePty,
  createRemotePty,
  type PtyRemoteState,
} from "./pty-client.js";
const TerminalWindow = lazy(async () => {
  const module = await import("./TerminalWindow.js");
  return { default: module.TerminalWindow };
});

export interface TerminalServerSummary {
  id: string;
  name: string;
  status: "online" | "offline";
  username?: string;
}

export interface TerminalTab {
  id: string;
  terminalId: string;
  terminalToken: string;
  serverId: string;
  title: string;
  status: PtyRemoteState;
  reconnectToken: number;
}

function reasonFor(error: unknown): string {
  if (error instanceof PtyApiError) return error.userMessage;
  return error instanceof Error ? error.message : String(error);
}

export function TerminalTabs({
  servers,
  remotePtyEnabled = false,
}: {
  servers: TerminalServerSummary[];
  remotePtyEnabled?: boolean;
}) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>();
  const [split, setSplit] = useState(false);
  const [openingServerId, setOpeningServerId] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const tabsRef = useRef<TerminalTab[]>([]);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const visibleTabs = split ? tabs.slice(0, 2) : activeTab === undefined ? [] : [activeTab];
  tabsRef.current = tabs;

  useEffect(() => () => {
    for (const tab of tabsRef.current) {
      void closeRemotePty(tab.terminalId, tab.terminalToken).catch(() => {
        // Cleanup is best effort after the page or terminal view is gone.
      });
    }
  }, []);

  const updateTab = (
    terminalId: string,
    change: (tab: TerminalTab) => TerminalTab,
  ) => {
    setTabs((current) => current.map((tab) => (
      tab.terminalId === terminalId ? change(tab) : tab
    )));
  };

  const openServer = async (server: TerminalServerSummary) => {
    const existing = tabs.find((tab) => tab.serverId === server.id);
    if (existing !== undefined) {
      setActiveTabId(existing.id);
      return;
    }
    if (!remotePtyEnabled) {
      setNotice("远程终端仅在 DSH 插件入口可用。");
      return;
    }
    if (server.status !== "online") {
      setNotice("节点当前离线，无法创建远程终端。");
      return;
    }
    if (openingServerId !== undefined) return;

    setOpeningServerId(server.id);
    setNotice(undefined);
    try {
      const created = await createRemotePty({
        nodeId: server.id,
        cols: 100,
        rows: 30,
      });
      const tab: TerminalTab = {
        id: created.terminalId,
        terminalId: created.terminalId,
        terminalToken: created.terminalToken,
        serverId: server.id,
        title: server.name,
        status: "connecting",
        reconnectToken: 0,
      };
      setTabs((current) => [...current, tab]);
      setActiveTabId(tab.id);
    } catch (error) {
      setNotice(reasonFor(error));
    } finally {
      setOpeningServerId(undefined);
    }
  };

  const closeTab = (tab: TerminalTab) => {
    setTabs((current) => current.filter((candidate) => candidate.id !== tab.id));
    if (activeTabId === tab.id) setActiveTabId(undefined);
    void closeRemotePty(tab.terminalId, tab.terminalToken).catch((error: unknown) => {
      setNotice(reasonFor(error));
    });
  };

  return (
    <section className="fusion-terminal-workspace">
      <aside className="fusion-terminal-servers" aria-label="SSH 服务器">
        <div>
          <strong>SSH Hub</strong>
          <small>{servers.filter((server) => server.status === "online").length} 在线</small>
        </div>
        {servers.map((server) => (
          <button
            type="button"
            key={server.id}
            aria-label={`打开 ${server.name} 终端`}
            disabled={openingServerId !== undefined}
            onClick={() => void openServer(server)}
          >
            <span className={`fusion-node-dot ${server.status}`} />
            <span>{server.name}</span>
            <Plus size={13} />
          </button>
        ))}
        {notice === undefined ? null : (
          <p className="fusion-terminal-notice" role="status">{notice}</p>
        )}
      </aside>
      <div className="fusion-terminal-main">
        <div className="fusion-terminal-tabbar">
          <div role="tablist" aria-label="终端标签">
            {tabs.map((tab) => (
              <div
                className="fusion-terminal-tab"
                data-active={tab.id === activeTab?.id ? "true" : undefined}
                key={tab.id}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTab?.id}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <SquareTerminal size={13} />
                  <span>{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="fusion-terminal-tab-close"
                  aria-label={`关闭 ${tab.title}`}
                  onClick={() => closeTab(tab)}
                >
                  <X size={11} />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            className="fusion-terminal-split"
            aria-label="切换分屏"
            onClick={() => setSplit((current) => !current)}
          >
            <Columns2 size={14} />
          </button>
        </div>
        {visibleTabs.length === 0 ? (
          <div className="fusion-terminal-empty">
            <SquareTerminal size={28} />
            <strong>选择一个 SSH 服务器</strong>
            <span>远程 PTY 会按需启动，默认最多 4 个活动会话。</span>
          </div>
        ) : (
          <Suspense fallback={<div className="fusion-terminal-loading">正在准备终端…</div>}>
            <div className={`fusion-terminal-grid${split ? " is-split" : ""}`}>
              {visibleTabs.map((tab) => {
                const server = servers.find((candidate) => candidate.id === tab.serverId);
                if (server === undefined) return null;
                return (
                  <TerminalWindow
                    key={tab.id}
                    server={server}
                    tab={tab}
                    onStatusChange={(status) => updateTab(tab.terminalId, (current) => ({
                      ...current,
                      status,
                    }))}
                    onError={(message) => setNotice(message)}
                    onReconnect={() => {
                      updateTab(tab.terminalId, (current) => ({
                        ...current,
                        status: "reconnecting",
                        reconnectToken: current.reconnectToken + 1,
                      }));
                    }}
                  />
                );
              })}
            </div>
          </Suspense>
        )}
      </div>
    </section>
  );
}
