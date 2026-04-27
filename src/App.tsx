import { useCallback, useEffect, useRef, useState } from "react";

import type { WTerm } from "@wterm/dom";
import { Terminal, useTerminal } from "@wterm/react";

type ConnectionState = "connecting" | "connected" | "disconnected" | "error";

type ClientMessage =
  | {
      type: "input";
      data: string;
    }
  | {
      type: "resize";
      cols: number;
      rows: number;
    };

type UsageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; output: string }
  | { status: "error"; message: string };

const TERMINAL_ENDPOINT = "/ws/amp";

function App() {
  const { focus, ref, write } = useTerminal();
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [sessionNumber, setSessionNumber] = useState(1);
  const [usage, setUsage] = useState<UsageState>({ status: "idle" });

  const closeSession = useCallback(() => {
    wsRef.current?.close(1000, "Client restart requested");
    wsRef.current = null;
  }, []);

  useEffect(() => closeSession, [closeSession]);

  const sendMessage = useCallback((message: ClientMessage) => {
    const socket = wsRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(JSON.stringify(message));
  }, []);

  const handleReady = useCallback(
    (terminal: WTerm) => {
      closeSession();
      setConnectionState("connecting");

      const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${socketProtocol}//${window.location.host}${TERMINAL_ENDPOINT}`,
      );

      wsRef.current = socket;

      socket.binaryType = "arraybuffer";

      socket.addEventListener("open", () => {
        setConnectionState("connected");
        sendMessage({ type: "resize", cols: terminal.cols, rows: terminal.rows });
        focus();
      });

      socket.addEventListener("message", (event) => {
        if (typeof event.data === "string") {
          write(event.data);
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          write(new Uint8Array(event.data));
        }
      });

      socket.addEventListener("close", () => {
        setConnectionState("disconnected");
      });

      socket.addEventListener("error", () => {
        setConnectionState("error");
      });
    },
    [closeSession, focus, sendMessage, write],
  );

  const handleInput = useCallback(
    (data: string) => {
      sendMessage({ type: "input", data });
    },
    [sendMessage],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      sendMessage({ type: "resize", cols, rows });
    },
    [sendMessage],
  );

  const handleRestart = useCallback(() => {
    closeSession();
    setSessionNumber((current) => current + 1);
    setConnectionState("connecting");
  }, [closeSession]);

  const handleUsage = useCallback(async () => {
    setUsage({ status: "loading" });
    try {
      const response = await fetch("/api/usage");
      const text = await response.text();
      if (!response.ok) {
        setUsage({ status: "error", message: text || `HTTP ${response.status}` });
        return;
      }
      setUsage({ status: "loaded", output: text });
    } catch (error) {
      setUsage({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const closeUsage = useCallback(() => {
    setUsage({ status: "idle" });
    focus();
  }, [focus]);

  useEffect(() => {
    if (usage.status === "idle") {
      return;
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeUsage();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [usage.status, closeUsage]);

  const statusLabel: Record<ConnectionState, string> = {
    connecting: "connecting",
    connected: "connected",
    disconnected: "disconnected",
    error: "error",
  };

  const statusDot: Record<ConnectionState, string> = {
    connecting: "◌",
    connected: "●",
    disconnected: "○",
    error: "✗",
  };

  return (
    <main className="app-shell">
      <div className="tui-toolbar">
        <div className="tui-toolbar__row">
          <span className={`tui-status tui-status--${connectionState}`}>
            <span className="tui-status__dot">{statusDot[connectionState]}</span>
            <span className="tui-status__label">{statusLabel[connectionState]}</span>
          </span>

          <span className="tui-toolbar__spacer" />

          <button
            className="tui-button"
            type="button"
            onClick={handleUsage}
            disabled={usage.status === "loading"}
            title="Run `amp usage` and show the result"
          >
            [ amp usage ]
          </button>

          <button
            className="tui-button"
            type="button"
            onClick={handleRestart}
            title="Restart the Amp session"
          >
            [ reset ]
          </button>
        </div>
      </div>

      <div className="terminal-host">
        <Terminal
          key={sessionNumber}
          ref={ref}
          autoResize
          className="amp-terminal"
          cursorBlink
          onData={handleInput}
          onReady={handleReady}
          onResize={handleResize}
          rows={32}
          theme="monokai"
        />
      </div>

      {usage.status !== "idle" && <UsagePopup state={usage} onClose={closeUsage} />}
    </main>
  );
}

function UsagePopup({
  state,
  onClose,
}: {
  state: Exclude<UsageState, { status: "idle" }>;
  onClose: () => void;
}) {
  return (
    <div className="tui-popup__backdrop" onClick={onClose}>
      <div
        className="tui-popup"
        role="dialog"
        aria-label="amp usage output"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="tui-popup__title">
          <span className="tui-popup__title-text">─ amp usage ─</span>
          <button
            className="tui-popup__close"
            type="button"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            [ x ]
          </button>
        </div>

        <div
          className={
            "tui-popup__body" +
            (state.status === "error" ? " tui-popup__body--error" : "") +
            (state.status === "loading" ? " tui-popup__body--loading" : "")
          }
        >
          {state.status === "loading"
            ? "running `amp usage`..."
            : state.status === "error"
              ? state.message
              : state.output || "(no output)"}
        </div>

        <div className="tui-popup__hint">press Esc to close</div>
      </div>
    </div>
  );
}

export default App;
