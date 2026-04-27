import { spawn } from "node:child_process";
import { createServer as createNodeServer } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import express from "express";
import * as pty from "node-pty";
import type { ViteDevServer } from "vite";
import { createServer as createViteServer } from "vite";
import { WebSocket, WebSocketServer } from "ws";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const clientRoot = projectRoot;
const distRoot = path.join(projectRoot, "dist");
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 3000);
const envWorkspaceDir = process.env.AMP_WORKSPACE;
const ampCommand = process.env.AMP_COMMAND ?? "amp";

const pathSeparatorPattern = /[\\/]$/;
const windowsAbsolutePathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\)/;
const wsHeartbeatMs = 30_000;

interface HeartbeatWebSocket extends WebSocket {
  isAlive: boolean;
}

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

interface WorkspaceState {
  defaultPath: string;
  envWorkspaceDir: string | null;
  envWorkspaceValid: boolean;
  platform: NodeJS.Platform;
  requiresSelection: boolean;
  workspaceDir: string | null;
}

interface BrowseEntry {
  name: string;
  fullPath: string;
}

async function createApp() {
  const app = express();
  const httpServer = createNodeServer(app);
  const isProduction = process.env.NODE_ENV === "production";
  const workspaceState = await resolveWorkspaceState();

  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.json({
      command: ampCommand,
      host,
      ok: true,
      port,
      workspaceDir: workspaceState.workspaceDir,
    });
  });

  app.get("/api/workspace", (_request, response) => {
    response.json(workspaceState);
  });

  app.get("/api/workspace/browse", async (request, response) => {
    try {
      const inputPath = typeof request.query.path === "string" ? request.query.path : "";
      if (!inputPath.trim()) {
        response.status(400).json({ error: "Path is required." });
        return;
      }

      response.json(await browseWorkspacePath(inputPath));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/api/workspace/validate", async (request, response) => {
    try {
      const inputPath = typeof request.body?.path === "string" ? request.body.path : "";
      if (!inputPath.trim()) {
        response.status(400).json({ error: "Path is required." });
        return;
      }

      const workspaceDir = await validateWorkspaceDir(inputPath);
      response.json({ workspaceDir });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get("/api/usage", async (_request, response) => {
    try {
      const output = await runAmpUsage();
      response.type("text/plain").send(output);
    } catch (error) {
      response
        .status(500)
        .type("text/plain")
        .send(error instanceof Error ? error.message : String(error));
    }
  });

  if (isProduction) {
    app.use(express.static(distRoot));

    app.use((_request, response) => {
      response.sendFile(path.join(distRoot, "index.html"));
    });
  } else {
    const vite: ViteDevServer = await createViteServer({
      appType: "custom",
      root: clientRoot,
      server: {
        middlewareMode: true,
      },
    });

    app.use(vite.middlewares);

    app.use(async (request, response, next) => {
      try {
        const template = await readFile(path.join(clientRoot, "index.html"), "utf8");
        const indexHtml = await vite.transformIndexHtml(request.originalUrl, template);

        response.status(200).setHeader("Content-Type", "text/html").end(indexHtml);
      } catch (error) {
        vite.ssrFixStacktrace(error as Error);
        next(error);
      }
    });
  }

  const socketServer = new WebSocketServer({ noServer: true });
  const heartbeatInterval = setInterval(() => {
    for (const client of socketServer.clients) {
      const heartbeatClient = client as HeartbeatWebSocket;
      if (!heartbeatClient.isAlive) {
        heartbeatClient.terminate();
        continue;
      }

      heartbeatClient.isAlive = false;
      heartbeatClient.ping();
    }
  }, wsHeartbeatMs);
  heartbeatInterval.unref();

  socketServer.on("close", () => {
    clearInterval(heartbeatInterval);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host}`);

    if (requestUrl.pathname !== "/ws/amp") {
      socket.destroy();
      return;
    }

    socketServer.handleUpgrade(request, socket, head, (websocket) => {
      socketServer.emit("connection", websocket, request);
    });
  });

  socketServer.on("connection", async (websocket, request) => {
    const heartbeatSocket = websocket as HeartbeatWebSocket;
    heartbeatSocket.isAlive = true;
    websocket.on("pong", () => {
      heartbeatSocket.isAlive = true;
    });

    let sessionWorkspaceDir: string;
    try {
      sessionWorkspaceDir = await resolveWorkspaceForSession(request.url, workspaceState);
    } catch (error) {
      websocket.close(1008, error instanceof Error ? error.message : String(error));
      return;
    }

    const terminal = pty.spawn(resolveShell(), resolveShellArgs(ampCommand), {
      cols: 120,
      cwd: sessionWorkspaceDir,
      env: {
        ...process.env,
        COLORTERM: "truecolor",
        TERM: "xterm-256color",
        TERM_PROGRAM: "wterm",
      },
      name: "xterm-256color",
      rows: 32,
    });
    let isDisposed = false;

    const disposeTerminal = () => {
      if (isDisposed) {
        return;
      }

      isDisposed = true;
      terminal.kill();
    };

    terminal.onData((data) => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.send(data);
      }
    });

    terminal.onExit(() => {
      if (websocket.readyState === WebSocket.OPEN) {
        websocket.close(1000, "Amp session exited");
      }
    });

    websocket.on("message", (rawMessage, isBinary) => {
      if (isBinary) {
        return;
      }

      const message = parseMessage(rawMessage.toString());
      if (!message) {
        return;
      }

      if (message.type === "input") {
        terminal.write(message.data);
        return;
      }

      terminal.resize(message.cols, message.rows);
    });

    websocket.on("close", disposeTerminal);
    websocket.on("error", disposeTerminal);
  });

  httpServer.listen(port, host, () => {
    process.stdout.write(`Amp Web listening on http://${host}:${port}\n`);
  });
}

function parseMessage(payload: string): ClientMessage | null {
  try {
    const message = JSON.parse(payload) as Partial<ClientMessage>;

    if (message.type === "input" && typeof message.data === "string") {
      return { type: "input", data: message.data };
    }

    if (
      message.type === "resize" &&
      typeof message.cols === "number" &&
      typeof message.rows === "number"
    ) {
      return { type: "resize", cols: message.cols, rows: message.rows };
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveWorkspaceState(): Promise<WorkspaceState> {
  const envResolved = envWorkspaceDir ? resolveInputPath(envWorkspaceDir) : null;
  const envValid = envResolved ? await isDirectory(envResolved) : false;
  const fallbackDefaultPath = await resolveDefaultBrowsePath();

  return {
    defaultPath:
      envValid && envResolved ? ensureTrailingSeparator(envResolved) : fallbackDefaultPath,
    envWorkspaceDir: envResolved,
    envWorkspaceValid: envValid,
    platform: process.platform,
    requiresSelection: !envValid,
    workspaceDir: envValid && envResolved ? envResolved : null,
  };
}

async function resolveDefaultBrowsePath(): Promise<string> {
  const homeDir = os.homedir();
  if (homeDir && (await isDirectory(homeDir))) {
    return ensureTrailingSeparator(homeDir);
  }

  return ensureTrailingSeparator(projectRoot);
}

async function resolveWorkspaceForSession(
  requestUrl: string | undefined,
  workspaceState: WorkspaceState,
): Promise<string> {
  const parsedUrl = new URL(requestUrl ?? "/", `http://${host}:${port}`);
  const workspaceParam = parsedUrl.searchParams.get("workspace");

  if (workspaceParam?.trim()) {
    return validateWorkspaceDir(workspaceParam);
  }

  if (workspaceState.workspaceDir) {
    return workspaceState.workspaceDir;
  }

  throw new Error("Workspace selection is required.");
}

async function browseWorkspacePath(inputPath: string) {
  const resolvedInputPath = resolveInputPath(inputPath);
  const endsWithSeparator = pathSeparatorPattern.test(inputPath) || inputPath.trim() === "~";
  const parentPath = endsWithSeparator ? resolvedInputPath : path.dirname(resolvedInputPath);
  const prefix = endsWithSeparator ? "" : path.basename(resolvedInputPath);
  const dirents = await readdir(parentPath, { withFileTypes: true });
  const showHidden = endsWithSeparator || prefix.startsWith(".");
  const lowerPrefix = prefix.toLowerCase();
  const entries: BrowseEntry[] = dirents
    .filter(
      (dirent) =>
        dirent.isDirectory() &&
        dirent.name.toLowerCase().startsWith(lowerPrefix) &&
        (showHidden || !dirent.name.startsWith(".")),
    )
    .map((dirent) => ({
      fullPath: path.join(parentPath, dirent.name),
      name: dirent.name,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return { entries, parentPath };
}

async function validateWorkspaceDir(inputPath: string): Promise<string> {
  const resolvedPath = resolveInputPath(inputPath);
  const stats = await stat(resolvedPath);
  if (!stats.isDirectory()) {
    throw new Error(`Workspace is not a directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

async function isDirectory(inputPath: string): Promise<boolean> {
  try {
    return (await stat(inputPath)).isDirectory();
  } catch {
    return false;
  }
}

function resolveInputPath(inputPath: string): string {
  const trimmedPath = inputPath.trim();
  if (process.platform !== "win32" && windowsAbsolutePathPattern.test(trimmedPath)) {
    throw new Error("Windows-style paths are only supported on Windows.");
  }

  return path.resolve(expandHomePath(trimmedPath));
}

function expandHomePath(inputPath: string): string {
  if (inputPath === "~") {
    return os.homedir();
  }

  if (inputPath.startsWith("~/") || inputPath.startsWith("~\\")) {
    return path.join(os.homedir(), inputPath.slice(2));
  }

  return inputPath;
}

function ensureTrailingSeparator(inputPath: string): string {
  if (pathSeparatorPattern.test(inputPath)) {
    return inputPath;
  }

  return `${inputPath}${path.sep}`;
}

function runAmpUsage(): Promise<string> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    const command = `${ampCommand} usage`;
    const child = spawn(
      isWin ? (process.env.COMSPEC ?? "cmd.exe") : "/bin/sh",
      isWin ? ["/d", "/s", "/c", command] : ["-lc", command],
      {
        cwd: envWorkspaceDir ?? projectRoot,
        env: {
          ...process.env,
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
        },
      },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => reject(error));

    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout || stderr);
      } else {
        reject(new Error(stderr || stdout || `amp usage exited with code ${code}`));
      }
    });
  });
}

function resolveShell() {
  if (process.platform === "win32") {
    return process.env.COMSPEC ?? "cmd.exe";
  }

  return process.env.SHELL ?? "/bin/sh";
}

function resolveShellArgs(command: string) {
  if (process.platform === "win32") {
    return ["/d", "/s", "/c", command];
  }

  return ["-lc", command];
}

createApp().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
