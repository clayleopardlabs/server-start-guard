import { readFileSync } from "node:fs";
import type { ServerStartGuardConfig } from "./types.js";

/**
 * Active HTTP health probing — the observability layer that catches the two
 * states a PID check cannot: a process that is alive but serving 500s on
 * every route, and a process that is alive but never actually started
 * listening. Both are only visible by *hitting the server*.
 *
 * URL resolution is the one genuinely ambiguous step: the rewrite only ever
 * sees the command text, not the port the server will bind. We resolve a
 * probe URL in tiers:
 *   1. the address/port the process itself printed in its own logs
 *      (authoritative — dev servers increment their port when the requested
 *      one is taken, so a stale instance may hold the guessed port while the
 *      tracked process is actually serving elsewhere; see discoverBoundUrl);
 *   2. config `healthChecks` rules (pattern -> url), first substring match
 *      wins;
 *   3. a built-in preset map of well-known dev-server default ports
 *      (opt-out via `defaultHealthChecks: false`);
 *   4. none — pure PID + log-staleness monitoring only.
 */

export interface ProbablePort {
  pattern: RegExp;
  url: string;
}

/**
 * Well-known default ports for common dev servers, keyed loosely off the
 * command text. Deliberately inherited from the detection patterns; a
 * mismatch here only degrades the *health* signal (the probe describes a
 * server that answered), never the rewrite itself.
 */
const PRESET_PORTS: ProbablePort[] = [
  { pattern: /\bvite\b|sveltekit|svelte|astro\s+dev\b/i, url: "http://localhost:5173" },
  { pattern: /\bng\s+serve\b/i, url: "http://localhost:4200" },
  { pattern: /\bnext\s+dev\b|nuxt\b|create-react-app|react-scripts|webpack\b/i, url: "http://localhost:3000" },
  { pattern: /\buvicorn\b|\bgunicorn\b|flask\s+run|django[\w.:/-]*\s+runserver|manage\.py\s+runserver\b/i, url: "http://localhost:8000" },
  { pattern: /\bpython[\w.\s-]*-m\s+http\.server\b/i, url: "http://localhost:8000" },
  { pattern: /\bdotnet\s+run\b/i, url: "http://localhost:5000" },
  { pattern: /\bgo\s+run\s+[\w./\\-]*server\.go\b/i, url: "http://localhost:8080" },
];

/**
 * Resolve a health-check URL for a command, or undefined when nothing
 * sensible matches (the server will get PID/log monitoring only).
 */
export function resolveHealthUrl(
  command: string,
  cfg: ServerStartGuardConfig,
): string | undefined {
  for (const rule of cfg.healthChecks) {
    if (rule.pattern && command.includes(rule.pattern)) return rule.url;
  }
  if (!cfg.defaultHealthChecks) return undefined;
  for (const preset of PRESET_PORTS) {
    if (preset.pattern.test(command)) return preset.url;
  }
  return undefined;
}

/** Result kinds of one health probe. */
export type HttpProbeKind = "ok" | "broken" | "refused" | "timeout";

export interface HttpProbeResult {
  kind: HttpProbeKind;
  /** HTTP status when the server sent a real response, else null. */
  status: number | null;
  /** Human description for the UNHEALTHY announcement. */
  detail: string;
}

/**
 * Parse the host:port a dev server actually bound to from its own log
 * output. Last match wins because many servers first print "port in use,
 * trying N+1" before the real line. Only loopback URLs are accepted — a
 * process that prints a public address is serving it from somewhere we
 * may not be able to reach, so guessing worse is not helpful.
 */
export function discoverBoundUrl(
  outLog: string | undefined,
  errLog: string | undefined,
): string | undefined {
  let found: string | undefined;
  const re = /https?:\/\/(?:\[?::1\]?|localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s"'<>]*:\d+/gi;
  for (const log of [outLog, errLog]) {
    if (!log) continue;
    let text: string;
    try {
      text = readFileSync(log, "utf-8");
    } catch {
      continue;
    }
    for (const m of text.matchAll(re)) {
      if (m[0]) found = m[0];
    }
  }
  return found;
}

/**
 * Deterministic set of probe candidates for a URL, covering both loopback
 * families. Only hostname "localhost" is expanded (-> also literal IPv4 and
 * IPv6 loopbacks, since a server binding ::1 alone fails a 127.0.0.1 probe
 * and vice versa); a literal 127.0.0.1/::1 is the server's own printed bind
 * address and is probed as-is. "0.0.0.0" (bound to all interfaces) maps to
 * the IPv4 loopback it is guaranteed to include.
 */
export function probeCandidates(url: string): string[] {
  const candidates: string[] = [];
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return [url];
    let hosts: string[];
    if (u.hostname === "localhost") hosts = ["127.0.0.1", "::1", "localhost"];
    else if (u.hostname === "0.0.0.0") hosts = ["127.0.0.1"];
    else hosts = [u.hostname];
    for (const host of hosts) {
      const c = new URL(url);
      c.hostname = host === "::1" ? "[::1]" : host;
      candidates.push(c.toString());
    }
  } catch {
    candidates.push(url);
  }
  return [...new Set(candidates)];
}

/**
 * Probe a URL with a hard wall-clock timeout, returning a classified result
 * — NOT a boolean. The classification is the whole point:
 *   - ok      — real HTTP response < 500. The only state that advances the
 *               "last successful response" clock.
 *   - broken  — real HTTP response >= 500. The server answers, just badly.
 *   - refused — connection error (nothing listening on that address).
 *   - timeout — the socket opened but no first response byte arrived within
 *               timeoutMs. The "kernel accepted into the backlog, the app is
 *               wedged or mid-recompile" case — distinct from refused,
 *               because a stuck server is NOT dead.
 */
export async function probeHttp(url: string, timeoutMs: number): Promise<HttpProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow" });
    if (res.status >= 500) {
      return { kind: "broken", status: res.status, detail: `HTTP ${res.status}` };
    }
    return { kind: "ok", status: res.status, detail: `HTTP ${res.status}` };
  } catch (err) {
    // Node's fetch wraps socket-level failures in a TypeError with the real
    // error in `cause` — read the code from either depth.
    const cause = (err as { cause?: NodeJS.ErrnoException })?.cause;
    const code = (err as NodeJS.ErrnoException).code ?? cause?.code;
    if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "EADDRNOTAVAIL") {
      return { kind: "refused", status: null, detail: "connection refused" };
    }
    if ((err as Error).name === "AbortError") {
      return { kind: "timeout", status: null, detail: `no response in ${timeoutMs}ms` };
    }
    // ECONNRESET / ETIMEDOUT / anything else the socket layer raised.
    return { kind: "timeout", status: null, detail: `socket error (${code ?? "unknown"})` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Probe a URL across its address-family candidates in parallel (so total wait
 * is bounded by one timeout, not candidates × timeout). Real responses win: an
 * `ok`/`broken` answer from any candidate is authoritative; only when every
 * candidate failed do we report the "worst" (preferring a definite refusal
 * over a shrug of a timeout).
 */
export async function probeHttpAny(url: string, timeoutMs: number): Promise<HttpProbeResult> {
  const candidates = probeCandidates(url);
  const results = await Promise.all(candidates.map((c) => probeHttp(c, timeoutMs)));

  const real = results.findIndex((r) => r.kind === "ok" || r.kind === "broken");
  if (real !== -1) {
    const r = results[real];
    return { ...r, detail: `${r.detail} (${candidates[real]})` };
  }
  const refused = results.findIndex((r) => r.kind === "refused");
  if (refused !== -1) {
    return { kind: "refused", status: null, detail: `connection refused (${candidates[refused]})` };
  }
  const timeout = results.findIndex((r) => r.kind === "timeout");
  if (timeout !== -1) {
    const r = results[timeout];
    return { ...r, detail: `${r.detail} (${candidates[timeout]})` };
  }
  return { kind: "timeout", status: null, detail: `no response in ${timeoutMs}ms` };
}