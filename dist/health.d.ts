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
 * Resolve a health-check URL for a command, or undefined when nothing
 * sensible matches (the server will get PID/log monitoring only).
 */
export declare function resolveHealthUrl(command: string, cfg: ServerStartGuardConfig): string | undefined;
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
export declare function discoverBoundUrl(outLog: string | undefined, errLog: string | undefined): string | undefined;
/**
 * Deterministic set of probe candidates for a URL, covering both loopback
 * families. Only hostname "localhost" is expanded (-> also literal IPv4 and
 * IPv6 loopbacks, since a server binding ::1 alone fails a 127.0.0.1 probe
 * and vice versa); a literal 127.0.0.1/::1 is the server's own printed bind
 * address and is probed as-is. "0.0.0.0" (bound to all interfaces) maps to
 * the IPv4 loopback it is guaranteed to include.
 */
export declare function probeCandidates(url: string): string[];
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
export declare function probeHttp(url: string, timeoutMs: number): Promise<HttpProbeResult>;
/**
 * Probe a URL across its address-family candidates in parallel (so total wait
 * is bounded by one timeout, not candidates × timeout). Real responses win: an
 * `ok`/`broken` answer from any candidate is authoritative; only when every
 * candidate failed do we report the "worst" (preferring a definite refusal
 * over a shrug of a timeout).
 */
export declare function probeHttpAny(url: string, timeoutMs: number): Promise<HttpProbeResult>;
