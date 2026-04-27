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

type UsageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; output: string }
  | { status: "error"; message: string };

type WorkspaceBootstrapState =
  | { status: "loading" }
  | { status: "ready"; workspaceDir: string }
  | { status: "picking"; initialPath: string; message?: string }
  | { status: "error"; message: string };

interface WorkspaceState {
  defaultPath: string;
  envWorkspaceDir: string | null;
  envWorkspaceValid: boolean;
  platform: string;
  requiresSelection: boolean;
  workspaceDir: string | null;
}

interface WorkspaceBrowseEntry {
  name: string;
  fullPath: string;
}

interface WorkspaceBrowseResult {
  parentPath: string;
  entries: WorkspaceBrowseEntry[];
}

const TERMINAL_ENDPOINT = "/ws/amp";

function App() {
  const { focus, ref, write } = useTerminal();
  const wsRef = useRef<WebSocket | null>(null);
  const usageRequestIdRef = useRef(0);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [sessionNumber, setSessionNumber] = useState(1);
  const [usage, setUsage] = useState<UsageState>({ status: "idle" });
  const [workspaceBootstrap, setWorkspaceBootstrap] = useState<WorkspaceBootstrapState>({
    status: "loading",
  });
  const [workspaceDialogInitialPath, setWorkspaceDialogInitialPath] = useState<string | null>(null);
  const [platform, setPlatform] = useState("");

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

  useEffect(() => {
    let isDisposed = false;

    async function loadWorkspaceState() {
      try {
        const response = await fetch("/api/workspace");
        const workspaceState = (await response.json()) as WorkspaceState;
        if (!response.ok) {
          throw new Error("error" in workspaceState ? String(workspaceState.error) : "HTTP error");
        }
        if (isDisposed) {
          return;
        }

        setPlatform(workspaceState.platform);
        if (!workspaceState.requiresSelection && workspaceState.workspaceDir) {
          setWorkspaceBootstrap({
            status: "ready",
            workspaceDir: workspaceState.workspaceDir,
          });
          return;
        }

        setConnectionState("disconnected");
        setWorkspaceBootstrap({
          status: "picking",
          initialPath: workspaceState.defaultPath,
          ...(workspaceState.envWorkspaceDir && !workspaceState.envWorkspaceValid
            ? { message: `AMP_WORKSPACE is not a directory: ${workspaceState.envWorkspaceDir}` }
            : {}),
        });
      } catch (error) {
        if (!isDisposed) {
          setConnectionState("error");
          setWorkspaceBootstrap({
            status: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    void loadWorkspaceState();

    return () => {
      isDisposed = true;
    };
  }, []);

  const handleReady = useCallback(
    (terminal: WTerm) => {
      if (workspaceBootstrap.status !== "ready") {
        return;
      }

      closeSession();
      setConnectionState("connecting");

      const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(
        `${socketProtocol}//${window.location.host}${TERMINAL_ENDPOINT}?workspace=${encodeURIComponent(workspaceBootstrap.workspaceDir)}`,
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
    [closeSession, focus, sendMessage, workspaceBootstrap, write],
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

  const handleChangeWorkspace = useCallback(() => {
    const currentWorkspace =
      workspaceBootstrap.status === "ready" ? workspaceBootstrap.workspaceDir : "";
    setWorkspaceDialogInitialPath(ensureBrowseDirectoryPath(currentWorkspace, platform));
  }, [platform, workspaceBootstrap]);

  const handleWorkspaceSelected = useCallback(
    (workspaceDir: string) => {
      setUsage({ status: "idle" });
      setWorkspaceDialogInitialPath(null);
      closeSession();
      setConnectionState("connecting");
      setWorkspaceBootstrap({ status: "ready", workspaceDir });
      setSessionNumber((current) => current + 1);
    },
    [closeSession],
  );

  const handleUsage = useCallback(async () => {
    const requestId = usageRequestIdRef.current + 1;
    usageRequestIdRef.current = requestId;
    setUsage({ status: "loading" });
    try {
      const response = await fetch("/api/usage");
      const text = await response.text();
      if (usageRequestIdRef.current !== requestId) {
        return;
      }
      if (!response.ok) {
        setUsage({ status: "error", message: text || `HTTP ${response.status}` });
        return;
      }
      setUsage({ status: "loaded", output: text });
    } catch (error) {
      if (usageRequestIdRef.current !== requestId) {
        return;
      }
      setUsage({
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  const closeUsage = useCallback(() => {
    usageRequestIdRef.current += 1;
    setUsage({ status: "idle" });
    focus();
  }, [focus]);

  const closeWorkspaceDialog = useCallback(() => {
    setWorkspaceDialogInitialPath(null);
    focus();
  }, [focus]);

  useEffect(() => {
    if (workspaceDialogInitialPath === null) {
      return;
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeWorkspaceDialog();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeWorkspaceDialog, workspaceDialogInitialPath]);

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
            onClick={handleChangeWorkspace}
            disabled={workspaceBootstrap.status !== "ready"}
            title="Choose workspace"
          >
            [ workspace ]
          </button>

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

      {workspaceBootstrap.status === "ready" ? (
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
      ) : (
        <WorkspacePickerSurface
          state={workspaceBootstrap}
          platform={platform}
          onSelected={handleWorkspaceSelected}
          submitHint="Ctrl+Enter opens path"
        />
      )}

      {workspaceDialogInitialPath !== null && (
        <WorkspacePickerDialog
          initialPath={workspaceDialogInitialPath}
          platform={platform}
          onClose={closeWorkspaceDialog}
          onSelected={handleWorkspaceSelected}
        />
      )}

      {usage.status !== "idle" && <UsagePopup state={usage} onClose={closeUsage} />}
    </main>
  );
}

function WorkspacePickerDialog({
  initialPath,
  platform,
  onClose,
  onSelected,
}: {
  initialPath: string;
  platform: string;
  onClose: () => void;
  onSelected: (workspaceDir: string) => void;
}) {
  return (
    <div className="tui-popup__backdrop" onClick={onClose}>
      <div onClick={(event) => event.stopPropagation()}>
        <WorkspacePickerSurface
          state={{ status: "picking", initialPath }}
          platform={platform}
          onClose={onClose}
          onSelected={onSelected}
          submitHint="Ctrl+Enter switches workspace"
          variant="dialog"
        />
      </div>
    </div>
  );
}

function WorkspacePickerSurface({
  state,
  platform,
  onClose,
  onSelected,
  submitHint,
  variant = "page",
}: {
  state: Exclude<WorkspaceBootstrapState, { status: "ready" }>;
  platform: string;
  onClose?: () => void;
  onSelected: (workspaceDir: string) => void;
  submitHint: string;
  variant?: "page" | "dialog";
}) {
  const [pathInput, setPathInput] = useState(state.status === "picking" ? state.initialPath : "");
  const [browseResult, setBrowseResult] = useState<WorkspaceBrowseResult | null>(null);
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [isOpening, setIsOpening] = useState(false);

  useEffect(() => {
    if (state.status === "picking") {
      setPathInput(state.initialPath);
    }
  }, [state]);

  const browseDirectoryPath = useMemo(
    () => getBrowseDirectoryPath(pathInput, platform),
    [pathInput, platform],
  );
  const browseFilter = useMemo(
    () => getBrowseLeafPathSegment(pathInput, platform),
    [pathInput, platform],
  );
  const entries = browseResult?.entries ?? [];

  useEffect(() => {
    if (state.status !== "picking" || !pathInput.trim()) {
      return;
    }

    const controller = new AbortController();
    setIsBrowsing(true);
    setBrowseError(null);

    fetch(`/api/workspace/browse?path=${encodeURIComponent(pathInput)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`);
        }
        return payload as WorkspaceBrowseResult;
      })
      .then((result) => {
        setBrowseResult(result);
        setHighlightedIndex(result.entries.length > 0 ? 0 : -1);
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setBrowseResult(null);
        setHighlightedIndex(-1);
        setBrowseError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsBrowsing(false);
        }
      });

    return () => controller.abort();
  }, [pathInput, state.status]);

  const browseTo = useCallback(
    (entry: WorkspaceBrowseEntry) => {
      setPathInput(appendBrowsePathSegment(pathInput, entry.name, platform));
    },
    [pathInput, platform],
  );

  const browseUp = useCallback(() => {
    const parentPath = getBrowseParentPath(browseDirectoryPath, platform);
    if (parentPath) {
      setPathInput(parentPath);
    }
  }, [browseDirectoryPath, platform]);

  const openWorkspace = useCallback(async () => {
    const selectedPath = hasTrailingPathSeparator(pathInput, platform)
      ? (browseResult?.parentPath ?? pathInput)
      : (entries.find((entry) => entry.name === browseFilter)?.fullPath ?? pathInput);

    setIsOpening(true);
    setBrowseError(null);
    try {
      const response = await fetch("/api/workspace/validate", {
        body: JSON.stringify({ path: selectedPath }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload?.error ?? `HTTP ${response.status}`);
      }
      onSelected(payload.workspaceDir);
    } catch (error) {
      setBrowseError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsOpening(false);
    }
  }, [browseFilter, browseResult?.parentPath, entries, onSelected, pathInput, platform]);

  function handlePickerKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.min(current + 1, entries.length - 1));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setHighlightedIndex((current) => Math.max(current - 1, 0));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (event.ctrlKey) {
        void openWorkspace();
        return;
      }

      const entry = entries[highlightedIndex];
      if (entry) {
        browseTo(entry);
      }
      return;
    }

    if (event.key === "Backspace" && pathInput === browseDirectoryPath) {
      event.preventDefault();
      browseUp();
    }
  }

  if (state.status === "loading") {
    return <div className="workspace-picker workspace-picker--message">loading workspace...</div>;
  }

  if (state.status === "error") {
    return (
      <div className="workspace-picker workspace-picker--message workspace-picker--error">
        {state.message}
      </div>
    );
  }

  return (
    <section
      className={"workspace-picker" + (variant === "dialog" ? " workspace-picker--dialog" : "")}
      aria-label="Workspace picker"
    >
      <div className="workspace-picker__frame">
        <div className="workspace-picker__title">
          <span className="workspace-picker__title-text">─ workspace ─</span>
          {onClose && (
            <button
              className="tui-popup__close"
              type="button"
              onClick={onClose}
              aria-label="Close"
              title="Close (Esc)"
            >
              [ x ]
            </button>
          )}
        </div>
        <div className="workspace-picker__input-row">
          <span className="workspace-picker__prompt">$</span>
          <input
            className="workspace-picker__input"
            value={pathInput}
            spellCheck={false}
            autoFocus
            onChange={(event) => setPathInput(event.target.value)}
            onKeyDown={handlePickerKeyDown}
            aria-label="Workspace path"
          />
          <button
            className="tui-button"
            type="button"
            onClick={browseUp}
            disabled={!getBrowseParentPath(browseDirectoryPath, platform)}
          >
            [ up ]
          </button>
          <button className="tui-button" type="button" onClick={openWorkspace} disabled={isOpening}>
            {isOpening ? "[ opening ]" : "[ open ]"}
          </button>
        </div>

        {state.message && <div className="workspace-picker__notice">{state.message}</div>}

        <div className="workspace-picker__list" role="listbox" aria-label="Directories">
          {entries.map((entry, index) => (
            <button
              className={
                "workspace-picker__entry" +
                (index === highlightedIndex ? " workspace-picker__entry--active" : "")
              }
              key={entry.fullPath}
              type="button"
              role="option"
              aria-selected={index === highlightedIndex}
              onMouseEnter={() => setHighlightedIndex(index)}
              onClick={() => browseTo(entry)}
            >
              <span className="workspace-picker__entry-cursor">
                {index === highlightedIndex ? ">" : " "}
              </span>
              <span className="workspace-picker__entry-name">{entry.name}</span>
            </button>
          ))}

          {!isBrowsing && entries.length === 0 && !browseError && (
            <div className="workspace-picker__empty">(no directories)</div>
          )}
          {isBrowsing && <div className="workspace-picker__empty">reading directory...</div>}
        </div>

        <div
          className={
            "workspace-picker__footer" + (browseError ? " workspace-picker__footer--error" : "")
          }
        >
          {browseError ?? `arrows navigate · Enter opens directory · ${submitHint}`}
        </div>
      </div>
    </section>
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

function isWindowsPlatform(platform: string): boolean {
  return platform === "win32" || platform.toLowerCase().includes("win");
}

function isWindowsDrivePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^[a-zA-Z]:$/.test(value);
}

function hasTrailingPathSeparator(value: string, platform: string): boolean {
  if (isWindowsPlatform(platform) || isWindowsDrivePath(value)) {
    return value.endsWith("/") || value.endsWith("\\");
  }

  return value.endsWith("/");
}

function preferredPathSeparator(value: string, platform: string): "/" | "\\" {
  if (isWindowsPlatform(platform) || isWindowsDrivePath(value) || value.includes("\\")) {
    return "\\";
  }
  return "/";
}

function getLastPathSeparatorIndex(value: string, platform: string): number {
  if (isWindowsPlatform(platform) || isWindowsDrivePath(value) || value.includes("\\")) {
    return Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  }
  return value.lastIndexOf("/");
}

function getBrowseDirectoryPath(value: string, platform: string): string {
  if (hasTrailingPathSeparator(value, platform)) {
    return value;
  }

  const lastSeparatorIndex = getLastPathSeparatorIndex(value, platform);
  if (lastSeparatorIndex < 0) {
    return value;
  }

  return value.slice(0, lastSeparatorIndex + 1);
}

function getBrowseLeafPathSegment(value: string, platform: string): string {
  const lastSeparatorIndex = getLastPathSeparatorIndex(value, platform);
  return value.slice(lastSeparatorIndex + 1);
}

function ensureBrowseDirectoryPath(value: string, platform: string): string {
  const trimmedValue = value.trim();
  if (!trimmedValue || hasTrailingPathSeparator(trimmedValue, platform)) {
    return trimmedValue;
  }

  return `${trimmedValue}${preferredPathSeparator(trimmedValue, platform)}`;
}

function appendBrowsePathSegment(value: string, segment: string, platform: string): string {
  const separator = preferredPathSeparator(value, platform);
  return `${getBrowseDirectoryPath(value, platform)}${segment}${separator}`;
}

function getBrowseParentPath(value: string, platform: string): string | null {
  const separator = preferredPathSeparator(value, platform);
  let trimmedValue = value.trim();
  while (trimmedValue.length > 1 && /[\\/]/.test(trimmedValue.at(-1) ?? "")) {
    if (/^[a-zA-Z]:[\\/]$/.test(trimmedValue) || trimmedValue === "/") {
      break;
    }
    trimmedValue = trimmedValue.slice(0, -1);
  }

  if (trimmedValue === "/" || /^[a-zA-Z]:[\\/]?$/.test(trimmedValue)) {
    return null;
  }

  const lastSeparatorIndex = getLastPathSeparatorIndex(trimmedValue, platform);
  if (lastSeparatorIndex < 0) {
    return null;
  }

  if (lastSeparatorIndex === 2 && /^[a-zA-Z]:/.test(trimmedValue)) {
    return `${trimmedValue.slice(0, 2)}${separator}`;
  }

  if (lastSeparatorIndex === 0) {
    return "/";
  }

  return `${trimmedValue.slice(0, lastSeparatorIndex)}${separator}`;
}

export default App;
