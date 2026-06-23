/**
 * gate.ts — the deterministic speak/swallow decision.
 *
 * RED TEAM mandate (2026-06-23): the decision to voice an alert is the
 * security-critical part and MUST be deterministic code, never an LLM. A
 * quantized model deciding "is this worth the mic" fails silently. Here the
 * gate is a pure function over the alert; the LLM is used ONLY to phrase a line
 * the gate has already decided to speak (see phrase.ts).
 *
 * No untrusted alert text ever reaches a tool-capable agent. The narrator holds
 * no shell/file tools at all.
 */

export interface NtfyAlert {
  id: string;
  topic: string;
  title: string;
  message: string;
  priority: number; // ntfy 1..5 (5 = max/urgent)
  time: number; // unix seconds
  tags: string[];
}

export interface GateDecision {
  speak: boolean;
  reason: string;
  /** security-class alert → narrator should GreyNoise-validate any source IP before voicing */
  security: boolean;
  /** first source IP found in the alert text, if any */
  ip?: string;
}

// Operational events a NOC operator keys the mic for.
const SEVERITY_RE =
  /\b(down|offline|failed|failing|failure|broken|unreachable|crash(ed)?|outage|degraded|timeout|expired?|expiring|breach|unauthori[sz]ed|intrusion|denied|exploit|malware|ransom)\b/i;

// Cert/expiry phrasing that may not hit the word list above.
const CERT_RE = /\bcert(ificate)?\b.*\bexpir/i;

// Security-class → trigger GreyNoise validation of any source IP.
const SECURITY_RE =
  /\b(security|breach|unauthori[sz]ed|intrusion|attack|exploit|malware|ransom|brute[- ]?force|port[- ]?scan|scanning|c2|exfil)\b/i;

// First IPv4 in free text (good enough; IPv6 added if a feed needs it).
const IPV4_RE = /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/;

export interface GateConfig {
  /** speak any alert at or above this ntfy priority (default 4) */
  minPriority: number;
}

export const DEFAULT_GATE: GateConfig = { minPriority: 4 };

/**
 * Decide whether an alert warrants being spoken. Pure, synchronous, testable.
 * Dedup against already-seen ids is the narrator's job, not the gate's.
 */
export function evaluate(alert: NtfyAlert, cfg: GateConfig = DEFAULT_GATE): GateDecision {
  const text = `${alert.title}\n${alert.message}`;
  const security = SECURITY_RE.test(text);
  const ipMatch = text.match(IPV4_RE);
  const ip = ipMatch ? ipMatch[0] : undefined;

  if (alert.priority >= cfg.minPriority) {
    return { speak: true, reason: `priority ${alert.priority} >= ${cfg.minPriority}`, security, ip };
  }
  if (SEVERITY_RE.test(text) || CERT_RE.test(text)) {
    return { speak: true, reason: "severity keyword", security, ip };
  }
  return { speak: false, reason: "routine; below threshold and no severity signal", security, ip };
}
