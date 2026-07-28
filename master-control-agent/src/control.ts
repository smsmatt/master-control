/**
 * control.ts — two-way presence. Master Control listens on a dedicated ntfy
 * control topic (MC_CONTROL_TOPIC, default "mc-control") for operator
 * directives and answers on the Code:Talker voice channel.
 *
 * RED TEAM mandate preserved: the directive text NEVER drives a tool or shell.
 * It only selects a pure-code intent (status / threats / help) via
 * `handleDirective`, which returns a deterministic line built from Master
 * Control's own state + the narration ledger — not from the LLM, not from the
 * untrusted text. Worst case for a spoofed directive is MC speaks its own
 * status. The reply is spoken AND recorded to the ledger.
 */
import { poll } from "./ntfy.js";
import { speak } from "./codetalker.js";
import { recordNarration, readRecent } from "./record.js";
import type { TickResult } from "./narrator.js";

export interface McStatus {
  online: boolean;
  topics: string[];
  // Type-only import of the daemon's own result shape, so a new counter cannot
  // be added to the loop and quietly go unreported here.
  last?: TickResult;
}

const CONTROL_TOPIC = () => process.env.MC_CONTROL_TOPIC ?? "mc-control";
const SINCE = () => process.env.MC_POLL_SINCE ?? "5m";

// In-memory dedup, seeded on boot so a restart never replays old directives.
const seen = new Set<string>();

/** Pure intent → spoken line. No I/O on the input; data comes from state/ledger. */
export function handleDirective(text: string, status: McStatus): string {
  const t = text.toLowerCase();

  if (/\b(status|online|alive|you there|sit-?rep|report)\b/.test(t)) {
    const l = status.last;
    const tail = l
      ? ` Last cycle: polled ${l.polled}, spoke ${l.spoken}, swallowed ${l.swallowed}${l.undelivered ? `, ${l.undelivered} undelivered` : ""}.`
      : "";
    // When an operator asks for status, a degraded phrasing leg is exactly the
    // thing they cannot otherwise see. Say it out loud rather than reporting a
    // clean cycle that happens to have been read from templates.
    const phrasing = l?.llmUnreachable ? " Phrasing model unreachable; speaking from templates." : "";
    return `Master Control online, watching ${status.topics.join(" and ")}.${tail}${phrasing}`;
  }

  if (/\b(threat|threats|security|ghostmode|attack|picture|incidents?)\b/.test(t)) {
    const recent = readRecent(80).filter((r) => r.security).slice(-3);
    if (recent.length === 0) return "No security alerts voiced recently. The board is quiet.";
    return `Recent security narrations: ${recent.map((r) => r.line).join(" / ")}`;
  }

  if (/\b(help|commands?|usage|what can you)\b/.test(t)) {
    return "Ask Master Control: status, threat picture, or help. I narrate ops feeds; I do not take actions.";
  }

  return "Master Control here. Ask me for status, the threat picture, or help.";
}

/** Seed the control seen-set from the recent window so boot doesn't replay backlog. */
export async function seedControl(): Promise<void> {
  try {
    for (const m of await poll(CONTROL_TOPIC(), SINCE())) seen.add(m.id);
  } catch {
    /* topic may be empty / unreachable — nothing to seed */
  }
}

/** Poll the control topic, answer each fresh directive. Returns how many handled. */
export async function pollControl(status: McStatus): Promise<number> {
  let msgs;
  try {
    msgs = await poll(CONTROL_TOPIC(), SINCE());
  } catch {
    return 0;
  }
  let handled = 0;
  for (const m of msgs) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const directive = (m.title ? `${m.title} ` : "") + m.message;
    const reply = handleDirective(directive, status);
    const ok = await speak(reply);
    recordNarration({
      ts: new Date().toISOString(),
      id: `control:${m.id}`,
      topic: CONTROL_TOPIC(),
      title: "directive",
      security: false,
      note: directive.slice(0, 120),
      line: reply,
      delivered: ok,
    });
    handled++;
  }
  return handled;
}
