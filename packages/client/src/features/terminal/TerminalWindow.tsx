import { useEffect, useRef, useState } from "react";
import { PlugZap, RotateCw } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RemotePtySocket, type PtyRemoteState } from "./pty-client.js";
import type { TerminalServerSummary, TerminalTab } from "./TerminalTabs.js";

const STATUS_LABEL: Record<PtyRemoteState, string> = {
  connecting: "连接中",
  connected: "已连接",
  reconnecting: "重新连接中",
  closed: "已关闭",
  error: "连接失败",
};

export function TerminalWindow({
  server,
  tab,
  onStatusChange,
  onError,
  onReconnect,
}: {
  server: TerminalServerSummary;
  tab: TerminalTab;
  onStatusChange: (state: PtyRemoteState) => void;
  onError: (message: string) => void;
  onReconnect: () => void;
}) {
  const username = server.username ?? "root";
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | undefined>(undefined);
  const fitAddonRef = useRef<FitAddon | undefined>(undefined);
  const connectionRef = useRef<RemotePtySocket | undefined>(undefined);
  const lastReconnectToken = useRef(tab.reconnectToken);
  const statusCallback = useRef(onStatusChange);
  const errorCallback = useRef(onError);
  const [error, setError] = useState<string>();

  statusCallback.current = onStatusChange;
  errorCallback.current = onError;

  useEffect(() => {
    const host = terminalHost.current;
    if (host === null) return;
    const terminal = new Terminal({
      convertEol: false,
      cursorBlink: true,
      // xterm only renders its accessibility live region
      // when screen reader mode is on; without it terminal
      // output is invisible to assistive technology.
      screenReaderMode: true,
      fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: {
        background: "#17191d",
        foreground: "#d9e1ef",
        cursor: "#8bb8ff",
        selectionBackground: "#334c70",
        black: "#17191d",
        brightBlack: "#687384",
        red: "#e58e8e",
        brightRed: "#ffaaaa",
        green: "#83d2a1",
        brightGreen: "#a4efbe",
        yellow: "#d7c479",
        brightYellow: "#f2df91",
        blue: "#8bb8ff",
        brightBlue: "#a8caff",
        magenta: "#c7a8ff",
        brightMagenta: "#dbc7ff",
        cyan: "#7fcfd8",
        brightCyan: "#a5eef3",
        white: "#d9e1ef",
        brightWhite: "#ffffff",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    fitAddon.fit();
    terminal.focus();

    const dataSubscription = terminal.onData((data) => {
      try {
        connectionRef.current?.sendInput(new TextEncoder().encode(data));
      } catch {
        // Input typed while reconnecting is intentionally dropped.
      }
    });
    const resizeSubscription = terminal.onResize(({ cols, rows }) => {
      try {
        connectionRef.current?.sendResize(cols, rows);
      } catch {
        // The next WebSocket open sends the current fitted dimensions.
      }
    });

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // xterm can briefly report zero dimensions while the pane is hidden.
      }
    };
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? undefined
      : new ResizeObserver(fit);
    resizeObserver?.observe(host);
    window.addEventListener("resize", fit);

    return () => {
      window.removeEventListener("resize", fit);
      resizeObserver?.disconnect();
      dataSubscription.dispose();
      resizeSubscription.dispose();
      terminal.dispose();
      terminalRef.current = undefined;
      fitAddonRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (terminal === undefined) return;
    const connection = new RemotePtySocket(tab.terminalId, tab.terminalToken, {
      onState: (state) => statusCallback.current(state),
      onSnapshot: (snapshot) => {
        terminal.reset();
        terminal.write(snapshot.data);
      },
      onOutput: (data) => terminal.write(data),
      onError: (code, message) => {
        const detail = code === message ? message : `${message}（${code}）`;
        setError(detail);
        errorCallback.current(detail);
      },
      onOpen: () => {
        setError(undefined);
        fitAddonRef.current?.fit();
        try {
          connection.sendResize(terminal.cols, terminal.rows);
        } catch {
          // The socket can close between the open event and this callback.
        }
      },
    });
    connectionRef.current = connection;
    connection.connect();
    return () => {
      if (connectionRef.current === connection) connectionRef.current = undefined;
      connection.dispose();
    };
  }, [tab.terminalId, tab.terminalToken]);

  useEffect(() => {
    if (lastReconnectToken.current === tab.reconnectToken) return;
    lastReconnectToken.current = tab.reconnectToken;
    setError(undefined);
    connectionRef.current?.reconnect();
  }, [tab.reconnectToken]);

  return (
    <section className="fusion-terminal-window" aria-label={`${server.name} 终端`}>
      <header>
        <span className={`fusion-session-state ${tab.status === "connected" ? "live" : "idle"}`} />
        <strong>{username}@{server.id}</strong>
        <small>{STATUS_LABEL[tab.status]}</small>
        <button type="button" onClick={onReconnect}>
          <RotateCw size={13} /> 重新连接
        </button>
      </header>
      {error === undefined ? null : (
        <p className="fusion-terminal-error" role="status">{error}</p>
      )}
      <div className="fusion-terminal-screen" ref={terminalHost} />
      <footer><PlugZap size={13} /> SSH PTY · xterm-256color</footer>
    </section>
  );
}
