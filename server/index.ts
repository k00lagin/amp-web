import { createServer as createNodeServer } from "node:http";
import { readFile } from "node:fs/promises";
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
const workspaceDir = process.env.AMP_WORKSPACE ?? projectRoot;
const ampCommand = process.env.AMP_COMMAND ?? "amp";

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

async function createApp() {
  const app = express();
  const httpServer = createNodeServer(app);
  const isProduction = process.env.NODE_ENV === "production";

  app.get("/health", (_request, response) => {
    response.json({
      command: ampCommand,
      host,
      ok: true,
      port,
      workspaceDir,
    });
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

  socketServer.on("connection", (websocket) => {
    const terminal = pty.spawn(resolveShell(), resolveShellArgs(ampCommand), {
      cols: 120,
      cwd: workspaceDir,
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
