/**
 * listen.ts: Master Control's inbound surface, so the Code:Talker bridge can
 * reach it at push-to-talk latency instead of the ntfy control topic's 120s poll.
 *
 * RED TEAM mandate preserved (see control.ts:6). This is a second TRANSPORT onto
 * the existing pure-code intent router, not a second router. The directive text
 * still only selects status / threats / help inside `handleDirective`, still
 * never drives a tool or a shell, and there is no shell here to drive. Worst case
 * for a spoofed directive on this port is that Master Control reads out its own
 * status, exactly as on the ntfy path.
 *
 * The contract is the one codetalker's bridge.ts on origin/main actually
 * implements, read from source rather than assumed:
 *
 *   GET  /health   registerAgent (bridge.ts:1430) sends NO auth header, even
 *                  when authToken is configured, and then calls
 *                  `await healthRes.json()`. So this endpoint must be open and
 *                  must return parseable JSON: a bearer-gated or plain-text
 *                  /health leaves the agent `healthy: false` forever.
 *   POST /mcp      JSON-RPC 2.0. mcpInitialize (bridge.ts:649) reads the session
 *                  from the `mcp-session-id` RESPONSE HEADER, not the body.
 *                  mcpCallTool invokes tool `respond` with
 *                  `{ message, from }` (bridge.ts:1255) and reads the reply from
 *                  `result.content[]` (type "text"), falling back to
 *                  `result.text`. A JSON-RPC `error` makes it re-initialize and
 *                  retry once, which is why a stale session answers with one.
 *
 * Runtime is Node (entrypoint.sh runs `node dist/index.js`), so this is
 * node:http, not Bun.serve.
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { handleDirective, type McStatus } from "./control.js";
import { speak } from "./codetalker.js";
import { recordNarration } from "./record.js";

// Read env per call, not at module load, so this stays testable. Matches the
// idiom already in control.ts and record.ts.
const PORT = () => Number(process.env.MC_LISTEN_PORT ?? 7910);
const HOST = () => process.env.MC_LISTEN_HOST ?? "0.0.0.0";
const TOKEN = () => process.env.MC_LISTEN_TOKEN ?? "";
const MCP_PATH = () => process.env.MC_LISTEN_MCP_PATH ?? "/mcp";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_BODY = 64 * 1024;
// Hard stop for a body we have already decided to refuse. We drain rather than
// destroy so the client gets its 413 instead of a connection reset, but we will
// not drain forever.
const MAX_DRAIN = 8 * 1024 * 1024;
const MAX_SESSIONS = 32;

/** Live MCP sessions, id to creation time. Bounded: oldest is evicted. */
const sessions = new Map<string, number>();

function newSession(): string {
  const id = randomUUID();
  sessions.set(id, Date.now());
  while (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined) break;
    sessions.delete(oldest);
  }
  return id;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: Record<string, unknown>;
  };
}

export interface RpcOutcome {
  status: number;
  /** Absent means "send no body at all", which is correct for a notification. */
  body?: unknown;
  /** Set on initialize only. Emitted as the `mcp-session-id` response header. */
  sessionId?: string;
}

const RESPOND_TOOL = {
  name: "respond",
  description:
    "Ask Master Control for its status, the recent threat picture, or help. " +
    "Master Control narrates ops feeds; it does not take actions.",
  inputSchema: {
    type: "object",
    properties: {
      message: { type: "string", description: "The directive text." },
      from: { type: "string", description: "The voice id of the sender." },
    },
    required: ["message"],
  },
};

function ok(id: JsonRpcMessage["id"], result: unknown): RpcOutcome {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, result } };
}

function rpcError(id: JsonRpcMessage["id"], code: number, message: string): RpcOutcome {
  return { status: 200, body: { jsonrpc: "2.0", id: id ?? null, error: { code, message } } };
}

/**
 * Answer one directive: pure-code intent, spoken, then recorded. Mirrors
 * pollControl (control.ts:83) so an HTTP directive and an ntfy directive land in
 * the same ledger and are graded by the same quality monitor.
 */
async function respond(text: string, from: string, status: McStatus): Promise<string> {
  const line = handleDirective(text, status);
  const delivered = await speak(line);
  recordNarration({
    ts: new Date().toISOString(),
    id: `listen:${randomUUID()}`,
    topic: MCP_PATH(),
    title: "directive",
    security: false,
    note: `from ${from || "unknown"}: ${text.slice(0, 120)}`,
    line,
    delivered,
  });
  return line;
}

/** Route one JSON-RPC message. Exported so the protocol is testable off-socket. */
export async function handleRpc(
  msg: JsonRpcMessage,
  sessionHeader: string | undefined,
  getStatus: () => McStatus,
): Promise<RpcOutcome> {
  const method = msg.method ?? "";

  if (method === "initialize") {
    return {
      status: 200,
      sessionId: newSession(),
      body: {
        jsonrpc: "2.0",
        id: msg.id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "master-control", version: "1.0.0" },
        },
      },
    };
  }

  // A notification carries no id and expects no reply body.
  if (method === "notifications/initialized") return { status: 202 };

  // Everything past the handshake needs a live session. Answering with a
  // JSON-RPC error rather than a bare 200 is what makes bridge.ts re-initialize
  // and retry, so a restart here is recoverable instead of a silent mute.
  if (!sessionHeader || !sessions.has(sessionHeader)) {
    return rpcError(msg.id, -32600, "No live session: send initialize first.");
  }

  if (method === "tools/list") return ok(msg.id, { tools: [RESPOND_TOOL] });

  if (method === "tools/call") {
    const name = msg.params?.name;
    if (name !== RESPOND_TOOL.name) {
      // Named, not echoed as executable intent. There is exactly one tool.
      return rpcError(msg.id, -32602, "Unsupported tool. Master Control exposes only 'respond'.");
    }
    const args = msg.params?.arguments ?? {};
    const text = typeof args.message === "string" ? args.message : "";
    const from = typeof args.from === "string" ? args.from : "";
    const line = await respond(text, from, getStatus());
    return ok(msg.id, { content: [{ type: "text", text: line }] });
  }

  return rpcError(msg.id, -32601, `Method not found: ${method}`);
}

/**
 * Constant-time bearer check. `timingSafeEqual` throws on a length mismatch, so
 * length is compared first; the length of a rejected token is not a secret worth
 * the crash.
 */
function authorized(header: string | undefined): boolean {
  const expected = TOKEN();
  if (!expected) return false;
  const presented = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
  if (body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(payload);
}

/** Buffer the request body up to MAX_BODY. Resolves null when it is too large. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let drained = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      drained += c.length;
      if (tooLarge) {
        // Keep consuming so the client can finish writing and read its 413
        // rather than seeing a connection reset, but do not do so indefinitely.
        if (drained > MAX_DRAIN) req.destroy();
        return;
      }
      size += c.length;
      if (size > MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(null));
  });
}

async function route(req: IncomingMessage, res: ServerResponse, getStatus: () => McStatus): Promise<void> {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;

  if (path === "/health") {
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
    // Open by design: the bridge's probe sends no credentials. This exposes the
    // same counters the tick line already prints, and nothing else.
    const s = getStatus();
    return send(res, 200, { ok: true, voice: "master-control", topics: s.topics, last: s.last ?? null });
  }

  if (path === MCP_PATH()) {
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
    if (!authorized(req.headers.authorization)) return send(res, 401, { error: "unauthorized" });

    const raw = await readBody(req);
    if (raw === null) return send(res, 413, { error: "payload too large" });

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }

    const sessionHeader = req.headers["mcp-session-id"];
    const outcome = await handleRpc(msg, Array.isArray(sessionHeader) ? sessionHeader[0] : sessionHeader, getStatus);
    return send(res, outcome.status, outcome.body, outcome.sessionId ? { "mcp-session-id": outcome.sessionId } : {});
  }

  // No path echo: an error page is not a place to reflect attacker-controlled text.
  return send(res, 404, { error: "not found" });
}

function defaultLog(msg: string): void {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

/**
 * Start the inbound listener. Returns null, having opened nothing, when no token
 * is configured: an unauthenticated directive endpoint on the LAN is worse than
 * no endpoint, so this fails closed and says why.
 */
export function startListener(getStatus: () => McStatus, log: (msg: string) => void = defaultLog): Server | null {
  if (!TOKEN()) {
    log("listener DISABLED: MC_LISTEN_TOKEN is empty. Refusing to open an unauthenticated directive endpoint.");
    return null;
  }
  const server = createServer((req, res) => {
    void route(req, res, getStatus).catch((err) => {
      log(`listener error: ${String(err)}`);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });
  server.on("error", (err) => log(`listener socket error: ${String(err)}`));
  server.listen(PORT(), HOST(), () => log(`listener on ${HOST()}:${PORT()} (health /health, mcp ${MCP_PATH()})`));
  return server;
}
