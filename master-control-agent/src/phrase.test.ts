/**
 * The grounding guard is what stops Master Control inventing facts aloud.
 *
 * It rejected a line whose digits were absent from the source, which the model
 * learned to walk around by spelling the numbers out. From the narration ledger:
 * "nearly fifty thousand seconds of failed probes" and "eight thousand
 * consecutive checks", both spoken from a record whose message field was empty.
 * The digit-only regex saw no digits, found nothing to check, and passed it.
 *
 * The system prompt already says "copy any number exactly as written, never
 * convert it to words". Nothing enforced it. These tests do.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { numeralsGrounded, phrase, fallbackLine } from "./phrase.js";
import type { NtfyAlert } from "./gate.js";

// --- digits, the original guard ---------------------------------------------

test("a digit present in the source is grounded", () => {
  assert.equal(numeralsGrounded("Master Control. 3 containers unhealthy. Out.", "3 containers unhealthy"), true);
});

test("a digit absent from the source is rejected", () => {
  assert.equal(numeralsGrounded("Master Control. Failing for 902 checks. Out.", "Database dev is down"), false);
});

test("a line with no numbers at all is grounded", () => {
  assert.equal(numeralsGrounded("Master Control. Endpoint unreachable. Out.", "endpoint unreachable"), true);
});

// --- word numerals, the bypass ----------------------------------------------

test("a spelled-out number absent from the source is rejected", () => {
  assert.equal(numeralsGrounded("Master Control. Eight thousand consecutive checks. Out.", ""), false);
});

test("the exact ledger line that got through is rejected", () => {
  assert.equal(
    numeralsGrounded("Master Control. Nearly fifty thousand seconds of failed probes. Out.", ""),
    false,
  );
});

test("a magnitude word alone is enough to reject", () => {
  assert.equal(numeralsGrounded("Master Control. Millions of requests blocked. Out.", "requests blocked"), false);
});

test("a small spelled-out number is still a claim", () => {
  assert.equal(numeralsGrounded("Master Control. Three databases are down. Out.", "database is down"), false);
});

test("a spelled-out number IS allowed when the source spells it too", () => {
  assert.equal(
    numeralsGrounded("Master Control. Three containers unhealthy. Out.", "three containers unhealthy"),
    true,
  );
});

test("a spelled-out number is allowed when the source has the digit", () => {
  assert.equal(numeralsGrounded("Master Control. Three containers unhealthy. Out.", "3 containers unhealthy"), true);
});

test("a digit is allowed when the source spells the number", () => {
  assert.equal(numeralsGrounded("Master Control. 3 containers unhealthy. Out.", "three containers unhealthy"), true);
});

// --- words that merely look numeric -----------------------------------------

test("ordinary prose containing 'one' as a pronoun is not a fabricated number", () => {
  // "no one", "one of", "someone" must not trip the guard and force the fallback
  // on every second line. The guard exists to catch invented counts.
  assert.equal(numeralsGrounded("Master Control. No one is on call. Out.", "nobody on call"), true);
  assert.equal(numeralsGrounded("Master Control. Someone forced a push. Out.", "forced push"), true);
});

test("the word 'a' and 'an' are not counted as the number one", () => {
  assert.equal(numeralsGrounded("Master Control. A container is unhealthy. Out.", "container unhealthy"), true);
});

test("case does not matter on either side", () => {
  assert.equal(numeralsGrounded("Master Control. THREE nodes are down. Out.", "Three nodes are down"), true);
});

// --- the guard must not become so strict it silences real alerts ------------

test("a full real alert phrased faithfully passes", () => {
  const source =
    "4 containers unhealthy on local. 4 containers are failing Docker health checks on local for >5m.";
  const line = "Master Control. 4 containers are failing health checks on local. Out.";
  assert.equal(numeralsGrounded(line, source), true);
});

test("a decimal is matched against the source verbatim", () => {
  assert.equal(numeralsGrounded("Master Control. Latency 1.5 seconds. Out.", "latency 1.5s"), true);
  assert.equal(numeralsGrounded("Master Control. Latency 2.5 seconds. Out.", "latency 1.5s"), false);
});

// --- talking to the model: auth, and which path produced the line ------------
//
// MTPLX began requiring an API key. phrase() sent no Authorization header, so
// every call 401'd and every line came from the deterministic template. Nothing
// showed it: the tick line read `spoken=1 undelivered=0` either way, because the
// fallback that protects a real alert from a dead model also hides the dead
// model. These tests pin both halves — the key is sent, and the path that
// produced the line is reported.

const ALERT: NtfyAlert = {
  id: "t1",
  topic: "universal-exports",
  title: "Dev NEST: DOWN",
  message: "Dev NEST is DOWN (dev-nest.thephenom.app).",
  priority: 5,
  time: 0,
  tags: [],
};

interface CapturedCall {
  url: string;
  headers: Record<string, string>;
}

/** An OpenAI-shaped completion carrying `content`. */
function llmSaid(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Run `fn` with global fetch swapped for `respond`, capturing what was sent. */
async function withStubbedLlm(
  respond: () => Response | Promise<Response>,
  fn: (calls: CapturedCall[]) => Promise<void>,
): Promise<void> {
  const calls: CapturedCall[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(input), headers: { ...(init?.headers ?? {}) } });
    return respond();
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = real;
  }
}

test("the key is sent as a bearer token when MC_LLM_KEY is set", async () => {
  process.env.MC_LLM_KEY = "sekrit";
  try {
    await withStubbedLlm(
      () => llmSaid("Master Control. Dev NEST is down. Out."),
      async (calls) => {
        const r = await phrase(ALERT);
        assert.equal(r.source, "llm");
        assert.equal(calls[0].headers.Authorization, "Bearer sekrit");
      },
    );
  } finally {
    delete process.env.MC_LLM_KEY;
  }
});

test("no Authorization header is sent when MC_LLM_KEY is absent", async () => {
  delete process.env.MC_LLM_KEY;
  await withStubbedLlm(
    () => llmSaid("Master Control. Dev NEST is down. Out."),
    async (calls) => {
      await phrase(ALERT);
      assert.equal(calls[0].headers.Authorization, undefined);
      assert.equal(calls[0].headers["Content-Type"], "application/json");
    },
  );
});

test("a 401 from the model is reported as unreachable, not as a normal line", async () => {
  await withStubbedLlm(
    () => new Response("missing or invalid API key", { status: 401 }),
    async () => {
      const r = await phrase(ALERT);
      assert.equal(r.source, "unreachable");
      assert.equal(r.line, fallbackLine(ALERT));
    },
  );
});

test("a network failure is reported as unreachable", async () => {
  await withStubbedLlm(
    () => {
      throw new Error("connect ECONNREFUSED");
    },
    async () => {
      const r = await phrase(ALERT);
      assert.equal(r.source, "unreachable");
      assert.equal(r.line, fallbackLine(ALERT));
    },
  );
});

test("an ungrounded line is reported as rejected, NOT as unreachable", async () => {
  // The distinction is the whole point: "rejected" means the grounding guard did
  // its job on a live model, "unreachable" means the dependency is dead. A single
  // fallback counter conflates a healthy system with a broken one.
  await withStubbedLlm(
    () => llmSaid("Master Control. Failing for 902 checks. Out."),
    async () => {
      const r = await phrase(ALERT);
      assert.equal(r.source, "rejected");
      assert.equal(r.line, fallbackLine(ALERT));
    },
  );
});

test("an empty completion is reported as rejected", async () => {
  await withStubbedLlm(
    () => llmSaid("   "),
    async () => {
      assert.equal((await phrase(ALERT)).source, "rejected");
    },
  );
});

test("a grounded line is spoken verbatim and reported as llm", async () => {
  await withStubbedLlm(
    () => llmSaid("Master Control. Dev NEST is down at dev-nest.thephenom.app. Out."),
    async () => {
      const r = await phrase(ALERT);
      assert.equal(r.source, "llm");
      assert.equal(r.line, "Master Control. Dev NEST is down at dev-nest.thephenom.app. Out.");
    },
  );
});

test("the note is carried into the fallback when the model is unreachable", async () => {
  await withStubbedLlm(
    () => new Response("", { status: 503 }),
    async () => {
      const r = await phrase(ALERT, "GreyNoise confirms 9.9.9.9 malicious");
      assert.equal(r.source, "unreachable");
      assert.match(r.line, /GreyNoise confirms 9\.9\.9\.9 malicious/);
    },
  );
});
