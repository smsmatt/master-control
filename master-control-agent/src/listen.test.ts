/**
 * listen.test.ts: the inbound surface, tested against the contract actually read
 * out of codetalker's bridge.ts on origin/main rather than a remembered one.
 *
 * The two clauses that decide whether this works at all:
 *   registerAgent (bridge.ts:1430) calls `await healthRes.json()` inside the
 *   same try as the fetch, so a 200 that is not parseable JSON throws and the
 *   agent stays `healthy: false`. A bare "ok" would look fine to curl and fail
 *   here.
 *
 *   mcpInitialize (bridge.ts:649) takes the session from the `mcp-session-id`
 *   RESPONSE HEADER, not the body. A perfectly formed initialize result with no
 *   header yields `sessionId: null`, and every later tools/call is skipped.
 *
 * Both are asserted below, because both are silent failures otherwise.
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { startListener } from "./listen.js";
import type { McStatus } from "./control.js";

// Captured before any stub replaces it: the tests are HTTP clients of the thing
// under test, so they must not go through the stub that stands in for speak().
const realFetch = globalThis.fetch.bind(globalThis);

const TOKEN = "test-token-0123456789abcdef";

function status(): McStatus {
  return {
    online: true,
    topics: ["universal-exports"],
    last: { polled: 4, fresh: 2, spoken: 1, swallowed: 1, undelivered: 0, fellBack: 0, llmUnreachable: 0 },
  };
}

let spoken: string[] = [];
let ledger = "";
let speakOk = true;

beforeEach(() => {
  spoken = [];
  speakOk = true;
  ledger = join(mkdtempSync(join(tmpdir(), "mc-listen-")), "narrations.jsonl");
  process.env.MC_NARRATION_LOG = ledger;
  process.env.MC_LISTEN_TOKEN = TOKEN;
  process.env.MC_LISTEN_PORT = "0"; // ephemeral; the OS picks a free port
  process.env.MC_LISTEN_HOST = "127.0.0.1";
  // Stand in for the Code:Talker bridge so nothing here reaches the real one.
  globalThis.fetch = (async (_url: unknown, init: { body?: string }) => {
    spoken.push(JSON.parse(String(init?.body ?? "{}")).text);
    return new Response(JSON.stringify({ ok: speakOk }), {
      status: speakOk ? 200 : 503,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
});

/** Start the listener on an ephemeral port, run `fn` against it, always close. */
async function serve(fn: (base: string) => Promise<void>): Promise<void> {
  const server = startListener(() => status(), () => {});
  assert.ok(server, "listener should start when a token is configured");
  await new Promise<void>((r) => server.once("listening", () => r()));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    // fetch keeps its socket alive, and server.close() waits for open
    // connections, so without this the suite hangs rather than fails.
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** POST a JSON-RPC message exactly as bridge.ts does, headers and all. */
function rpc(base: string, msg: unknown, sessionId?: string): Promise<Response> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${TOKEN}`,
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;
  return realFetch(`${base}/mcp`, { method: "POST", headers, body: JSON.stringify(msg) });
}

async function init(base: string): Promise<string> {
  const res = await rpc(base, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "claude-peers-bridge", version: "1.0.0" },
    },
  });
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid, "initialize must return an mcp-session-id header");
  return sid;
}

// --- fail closed -------------------------------------------------------------

test("refuses to start at all when MC_LISTEN_TOKEN is empty", () => {
  process.env.MC_LISTEN_TOKEN = "";
  const logs: string[] = [];
  // An unauthenticated directive endpoint on the LAN is worse than no endpoint,
  // so the failure mode is "do not open the socket", not "open it unguarded".
  const server = startListener(() => status(), (m) => logs.push(m));
  assert.equal(server, null);
  assert.match(logs.join(" "), /MC_LISTEN_TOKEN/);
});

// --- health, the thing the bridge probes -------------------------------------

test("GET /health is 2xx and parseable JSON, which is what registerAgent needs", async () => {
  await serve(async (base) => {
    // No Authorization header on purpose: bridge.ts:1430 sends none, even when
    // authToken is configured, so a bearer-gated /health would never flip healthy.
    const res = await realFetch(`${base}/health`);
    assert.equal(res.ok, true);
    const body = (await res.json()) as { ok: boolean; topics: string[] };
    assert.equal(body.ok, true);
    assert.deepEqual(body.topics, ["universal-exports"]);
  });
});

// --- auth --------------------------------------------------------------------

test("POST /mcp with no bearer is refused", async () => {
  await serve(async (base) => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
  });
});

test("POST /mcp with the wrong bearer is refused", async () => {
  await serve(async (base) => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer wrong-token-0123456789" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    assert.equal(res.status, 401);
  });
});

// --- the MCP handshake -------------------------------------------------------

test("initialize answers with the session in the RESPONSE HEADER", async () => {
  await serve(async (base) => {
    const res = await rpc(base, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: {} },
    });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("mcp-session-id"));
    const b = (await res.json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    assert.equal(b.result.protocolVersion, "2025-03-26");
    assert.equal(b.result.serverInfo.name, "master-control");
  });
});

test("notifications/initialized is accepted and returns no body", async () => {
  await serve(async (base) => {
    const sid = await init(base);
    const res = await rpc(base, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sid);
    assert.equal(res.status, 202);
    assert.equal((await res.text()).length, 0);
  });
});

test("tools/list advertises respond, the name the bridge calls", async () => {
  await serve(async (base) => {
    const sid = await init(base);
    const res = await rpc(base, { jsonrpc: "2.0", id: 2, method: "tools/list" }, sid);
    const b = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    assert.ok(b.result.tools.some((t) => t.name === "respond"));
  });
});

// --- the directive path ------------------------------------------------------

test("respond runs the pure-code handler, speaks the line, and records it", async () => {
  await serve(async (base) => {
    const sid = await init(base);
    const res = await rpc(
      base,
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "respond", arguments: { message: "Master control, what is your status?", from: "m" } },
      },
      sid,
    );
    const b = (await res.json()) as { result: { content: Array<{ type: string; text: string }> } };
    const text = b.result.content.find((c) => c.type === "text")!.text;
    assert.match(text, /Master Control online/);
    // A 200 from here is not proof it spoke. The bridge got the line too.
    assert.deepEqual(spoken, [text]);
    const rec = JSON.parse(readFileSync(ledger, "utf8").trim()) as { line: string; delivered: boolean };
    assert.equal(rec.line, text);
    assert.equal(rec.delivered, true);
  });
});

test("an undelivered reply is still written to the ledger", async () => {
  await serve(async (base) => {
    speakOk = false; // bridge down, or an empty room
    const sid = await init(base);
    await rpc(
      base,
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "respond", arguments: { message: "status", from: "m" } } },
      sid,
    );
    const rec = JSON.parse(readFileSync(ledger, "utf8").trim()) as { delivered: boolean };
    assert.equal(rec.delivered, false);
  });
});

test("the bridge's MHH preamble and context wrapper do not hide the intent", async () => {
  await serve(async (base) => {
    // getAgentResponse (bridge.ts:1243) sends preamble + context brief + the
    // real text, so the directive is the TAIL of the payload, never the whole
    // of it. Matching the whole string would have failed on every live call.
    const wrapped = [
      "You feel steady anticipation about this message.",
      "Seated personas: q, narrator.",
      "[INCOMING from m] Master control, give me a status report.",
    ].join("\n\n");
    const sid = await init(base);
    const res = await rpc(
      base,
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "respond", arguments: { message: wrapped, from: "m" } } },
      sid,
    );
    const b = (await res.json()) as { result: { content: Array<{ text: string }> } };
    assert.match(b.result.content[0].text, /Master Control online/);
  });
});

test("a stale session is a JSON-RPC error, which is the bridge's retry signal", async () => {
  await serve(async (base) => {
    // mcpCallTool throws on `data.error` and getAgentResponse then re-inits and
    // retries once. Returning a plain 200 with no error would burn that retry.
    const res = await rpc(
      base,
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "respond", arguments: { message: "status", from: "m" } } },
      "not-a-real-session",
    );
    const b = (await res.json()) as { error?: { message: string } };
    assert.ok(b.error, "a stale session must surface as a JSON-RPC error");
    assert.match(b.error.message, /initialize/i);
    assert.deepEqual(spoken, [], "a stale session must not reach the voice channel");
  });
});

test("an unknown tool is an error, not a spoken line", async () => {
  await serve(async (base) => {
    const sid = await init(base);
    const res = await rpc(
      base,
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "exec", arguments: { message: "rm -rf /" } } },
      sid,
    );
    const b = (await res.json()) as { error?: { code: number } };
    assert.ok(b.error);
    assert.deepEqual(spoken, []);
  });
});

test("an unknown method is a method-not-found error", async () => {
  await serve(async (base) => {
    const sid = await init(base);
    const res = await rpc(base, { jsonrpc: "2.0", id: 8, method: "resources/list" }, sid);
    const b = (await res.json()) as { error: { code: number } };
    assert.equal(b.error.code, -32601);
  });
});

// --- the rest of the surface -------------------------------------------------

test("an unknown path is 404 and does not echo the path back", async () => {
  await serve(async (base) => {
    const res = await realFetch(`${base}/admin-console-xyz`);
    assert.equal(res.status, 404);
    assert.ok(!(await res.text()).includes("admin-console-xyz"));
  });
});

test("GET /mcp is 405", async () => {
  await serve(async (base) => {
    const res = await realFetch(`${base}/mcp`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 405);
  });
});

test("an oversized body is refused rather than buffered", async () => {
  await serve(async (base) => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "x".repeat(200_000),
    });
    assert.equal(res.status, 413);
  });
});

test("a body that is not JSON is a parse error, not a crash", async () => {
  await serve(async (base) => {
    const res = await realFetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: "{not json",
    });
    const b = (await res.json()) as { error: { code: number } };
    assert.equal(b.error.code, -32700);
  });
});
