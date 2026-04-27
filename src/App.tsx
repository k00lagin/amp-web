import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

const TERMINAL_ENDPOINT = "/ws/amp";

function App() {
  const { focus, ref, write } = useTerminal();
  const wsRef = useRef<WebSocket | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [sessionNumber, setSessionNumber] = useState(1);

  const endpointLabel = useMemo(() => {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    return `${protocol}://${window.location.host}${TERMINAL_ENDPOINT}`;
  }, []);

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

  return (
    <main className="app-shell">
      <section className="frame">
        <header className="frame__header">
          <div>
            <p className="eyebrow">Local endpoint</p>
            <h1>Amp Web Terminal</h1>
          </div>

          <div className="header-actions">
            <span className={`status-pill status-pill--${connectionState}`}>{connectionState}</span>
            <button className="restart-button" onClick={handleRestart} type="button">
              Restart session
            </button>
          </div>
        </header>

        <div className="frame__meta">
          <span>{window.location.origin}</span>
          <span>{endpointLabel}</span>
        </div>

        <div className="terminal-panel">
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
      </section>
    </main>
  );
}

export default App;
