/**
 * ntfy.ts — poll the ops feeds. Deterministic fetch; no LLM involved.
 * Topics: universal-exports (ops/KPI) and ghostmode-alerts (security).
 */
import type { NtfyAlert } from "./gate.js";

const NTFY_URL = process.env.NTFY_URL ?? "http://127.0.0.1:8880";
const NTFY_TOKEN = process.env.NTFY_TOKEN ?? "";

// universal-exports alone by default: it is the operator's full feed, and
// ghostmode-alerts mirrors the same conditions as the Phenom client view, so
// subscribing to both announced everything twice.
export const TOPICS = (process.env.NTFY_TOPICS ?? "universal-exports")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

/** Poll one topic for messages newer than `since` (ntfy window e.g. "5m"). */
export async function poll(topic: string, since = "5m"): Promise<NtfyAlert[]> {
  const headers: Record<string, string> = {};
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  const url = `${NTFY_URL}/${topic}/json?poll=1&since=${encodeURIComponent(since)}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) throw new Error(`ntfy ${topic} HTTP ${res.status}`);
  const body = await res.text();
  const out: NtfyAlert[] = [];
  for (const line of body.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(s);
    } catch {
      continue;
    }
    if (ev.event !== "message") continue;
    out.push({
      id: String(ev.id ?? `${topic}:${ev.time ?? ""}`),
      topic,
      title: typeof ev.title === "string" ? ev.title : "",
      message: typeof ev.message === "string" ? ev.message : "",
      priority: typeof ev.priority === "number" ? ev.priority : 3,
      time: typeof ev.time === "number" ? ev.time : 0,
      tags: Array.isArray(ev.tags) ? (ev.tags as string[]) : [],
    });
  }
  return out;
}

/** Poll all configured topics; failures on one topic don't sink the rest. */
export async function pollAll(since = "5m"): Promise<NtfyAlert[]> {
  const results = await Promise.allSettled(TOPICS.map((t) => poll(t, since)));
  return results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
}
