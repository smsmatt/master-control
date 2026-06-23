/**
 * greynoise.ts — validate a suspicious source IP before escalating.
 * Private/loopback/reserved IPs are never sent off-box (RED TEAM H1).
 * Key from env GREYNOISE_API_KEY (pass: greynoise/api-key).
 */
const GREYNOISE_API = process.env.GREYNOISE_API ?? "https://api.greynoise.io/v3/community";
const GREYNOISE_API_KEY = process.env.GREYNOISE_API_KEY ?? "";

export interface GreyNoiseVerdict {
  ok: boolean;
  ip: string;
  classification: "malicious" | "benign" | "unknown" | "internal";
  noise: boolean;
  riot: boolean;
  name?: string;
  error?: string;
}

function isPrivate(ip: string): boolean {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return true; // malformed → treat as non-routable
  if (o[0] === 10) return true;
  if (o[0] === 127) return true; // loopback
  if (o[0] === 169 && o[1] === 254) return true; // link-local
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 0 || o[0] >= 224) return true; // this-network / multicast / reserved
  return false;
}

/** Returns a verdict. Internal IPs short-circuit to {classification: "internal"} and are never queried. */
export async function lookup(ip: string): Promise<GreyNoiseVerdict> {
  if (isPrivate(ip)) {
    return { ok: true, ip, classification: "internal", noise: false, riot: false };
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (GREYNOISE_API_KEY) headers.key = GREYNOISE_API_KEY;
  try {
    const res = await fetch(`${GREYNOISE_API}/${ip}`, { headers, signal: AbortSignal.timeout(12_000) });
    if (res.status === 404) {
      return { ok: true, ip, classification: "unknown", noise: false, riot: false, name: "not observed" };
    }
    if (!res.ok) return { ok: false, ip, classification: "unknown", noise: false, riot: false, error: `HTTP ${res.status}` };
    const d = (await res.json()) as Record<string, unknown>;
    return {
      ok: true,
      ip,
      classification: (d.classification as GreyNoiseVerdict["classification"]) ?? "unknown",
      noise: Boolean(d.noise),
      riot: Boolean(d.riot),
      name: typeof d.name === "string" ? d.name : undefined,
    };
  } catch (err) {
    return { ok: false, ip, classification: "unknown", noise: false, riot: false, error: String(err) };
  }
}

/** True only when GreyNoise actively flags the IP as a real, targeted threat. */
export function isRealThreat(v: GreyNoiseVerdict): boolean {
  return v.ok && v.classification === "malicious" && !v.riot;
}
