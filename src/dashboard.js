import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const ASSETS = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
]);

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};

export function createDashboardServer({ getSnapshot, onVideoCommand, onObsSceneCommand }) {
  if (typeof getSnapshot !== "function") {
    throw new TypeError("getSnapshot must be a function");
  }
  if (onVideoCommand !== undefined && typeof onVideoCommand !== "function") {
    throw new TypeError("onVideoCommand must be a function when provided");
  }
  if (onObsSceneCommand !== undefined && typeof onObsSceneCommand !== "function") {
    throw new TypeError("onObsSceneCommand must be a function when provided");
  }
  const dispatchVideoCommand =
    onVideoCommand ??
    (async () => {
      throw requestError(501, "Video commands are unavailable");
    });
  const dispatchObsSceneCommand =
    onObsSceneCommand ??
    (async () => {
      throw requestError(501, "OBS integration is unavailable");
    });

  const clients = new Set();
  const server = createServer(async (request, response) => {
    response.setHeaders(new Headers(SECURITY_HEADERS));

    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const videoCommandMatch = pathname.match(
      /^\/api\/terminals\/([^/]+)\/video\/(capabilities|start|stop|resync)$/,
    );

    if (request.method === "POST" && videoCommandMatch) {
      let terminalId;
      let parameters;
      try {
        terminalId = decodeURIComponent(videoCommandMatch[1]);
        parameters = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Invalid request",
        });
        return;
      }

      if (!/^\d{1,20}$/.test(terminalId)) {
        sendJson(response, 400, { error: "Invalid terminal ID" });
        return;
      }

      try {
        const result = await dispatchVideoCommand({
          terminalId,
          action: videoCommandMatch[2],
          parameters,
        });
        sendJson(response, 202, result);
      } catch (error) {
        sendJson(response, error.statusCode ?? 500, {
          error: error instanceof Error ? error.message : "Command failed",
        });
      }
      return;
    }

    if (request.method === "POST" && pathname === "/api/obs/scene") {
      let parameters;
      try {
        parameters = await readJsonBody(request);
      } catch (error) {
        sendJson(response, error.statusCode ?? 400, {
          error: error instanceof Error ? error.message : "Invalid request",
        });
        return;
      }

      try {
        const result = await dispatchObsSceneCommand(parameters);
        sendJson(response, 202, result ?? { ok: true });
      } catch (error) {
        sendJson(response, error.statusCode ?? 500, {
          error: error instanceof Error ? error.message : "Command failed",
        });
      }
      return;
    }

    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" });
      response.end("Method not allowed");
      return;
    }

    if (pathname === "/healthz") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    if (pathname === "/api/status") {
      sendJson(response, 200, getSnapshot());
      return;
    }

    if (pathname === "/api/stream") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Connection": "keep-alive",
      });
      response.flushHeaders();
      clients.add(response);
      response.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
      response.on("close", () => clients.delete(response));
      return;
    }

    const asset = ASSETS.get(pathname);
    if (!asset) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    try {
      const body = await readFile(new URL(`../web/${asset[0]}`, import.meta.url));
      response.writeHead(200, { "Content-Type": asset[1] });
      response.end(body);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "dashboard-asset-read-error",
          asset: asset[0],
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Dashboard asset unavailable");
    }
  });

  return {
    server,
    publish() {
      if (clients.size === 0) {
        return;
      }

      const update = `data: ${JSON.stringify(getSnapshot())}\n\n`;
      for (const client of clients) {
        if (!client.destroyed) {
          client.write(update);
        }
      }
    },
  };
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJsonBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw requestError(415, "Content-Type must be application/json");
  }

  const chunks = [];
  let totalLength = 0;
  for await (const chunk of request) {
    totalLength += chunk.length;
    if (totalLength > 2048) {
      throw requestError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }

  if (totalLength === 0) {
    return {};
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw requestError(400, "Request body must contain valid JSON");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw requestError(400, "Request body must be a JSON object");
  }
  return parsed;
}

function requestError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
