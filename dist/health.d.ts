import type { ServerStartGuardConfig } from "./types.js";
/**
 * Active HTTP health probing — the observability layer that catches the two
 * states a PID check cannot: a process that is alive but serving 500s on
 * every route, and a process that is alive but never actually started
 * listening. Both are only visible by *hitting the server*.
 *
 * URL resolution is the one genuinely ambiguous step: the rewrite only ever
 * sees the command text, not the port the server will bind. We resolve a
 * probe URL in three tiers:
 *   1. config `healthChecks` rules (pattern -> url), first substring match wins;
 *   2. a built-in preset map of well-known dev-server default ports
 *      (opt-out via `defaultHealthChecks: false`);
 *   3. none — pure PID + log-staleness monitoring only.
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
/**
 * Probe a URL with a hard wall-clock timeout. Resolves to the HTTP status
 * (2xx/3xx/4xx/5xx) when the server answers, or null when the connection
 * failed, the request timed out, or the host is unreachable. Treating
 * "reached a port" as success is deliberately NOT done: a bare TCP accept
 * with a 500 on every route is exactly the broken state we must flag.
 */
export declare function httpStatus(url: string, timeoutMs: number): Promise<number | null>;
