import { type HttpProbeKind } from "./health.js";
import type { ServerStartGuardConfig } from "./types.js";
/**
 * Status probes — the lazy, cross-platform observability half of the guard.
 *
 * On detach the rewrite writes a `.state.json` sidecar (schema below) next to
 * the logs, and the launched wrapper records the daemon pid in a sibling
 * `<stem>-<ts>.pid` file. On EVERY subsequent bash call the hook runs
 * `probeServers` (in-process, no child processes) against the state dir and
 * prepends a plain `echo`/`Write-Output` with any ANNOUNCEMENTS — before still
 * doing the pid existence check. The probe also actively checks HTTP health
 * when a probe URL can be resolved for the server.
 *
 * This replaces the older design of embedding a raw shell probe into the
 * command. Running the probe in the plugin's own process (Node) is strictly
 * more powerful and far less fragile:
 *   - it can perform real HTTP requests (the only way to catch a process that
 *     is alive but serving 500s / answering nothing);
 *   - it has no shell-quoting surface at all — the emitted command is nothing
 *     but literal `echo`/`Write-Output` lines (plus the original command);
 *   - it is identical across Windows and POSIX (no Get-Process vs kill -0
 *     divergence, no `find -mmin` vs LastWriteTime divergence).
 *
 * Fire-and-forget is preserved: no long-lived process is spawned. The agent's
 * own next bash command is the notification channel, so the probe is lazy
 * (runs then, not pushed). Only TRANSITIONS are announced:
 *   - DIED      — pid gone     (reported once, then state removed)
 *   - STALLED   — alive but no log write for STALLED_MS (answered once; a
 *                 later log write flips this back and announces RECOVERED)
 *   - UNHEALTHY — pid alive and past the boot grace, but for STALLED_MS there
 *                 has been NO last successful HTTP response (a real <500 from
 *                 the address families the server actually bound). A single
 *                 probe failure — timeout OR refused — is NOT a diagnosis on
 *                 its own (recompiles and slow boots pause a server well
 *                 inside the window); only a stale last-good response
 *                 escalates. Announced once per episode; the next real <500
 *                 response announces RECOVERED.
 *   - RECOVERED — server that was STALLED or UNHEALTHY is healthy again
 * Healthy servers are silent.
 *
 * Last-successful-response semantics are the whole point of the health half:
 * we never track "did the last probe happen to succeed", we track "when was
 * the last real <500 response". That single timestamp survives recompiles
 * (slow builds just age it) and separates a genuinely broken server from one
 * absorbed in a single slow request.
 */
/** Only announce "stalled" when NO log write happened for this window. */
export declare const STALLED_MS: number;
export interface ServerSidecar {
    command: string;
    workdir: string;
    startedAt: string;
    outLog: string;
    errLog: string;
    healthUrl?: string;
    /**
     * Effective probe URL. Starts as the rewrite-time guess (`healthUrl`), then
     * is replaced by the address the server printed in its own logs when one is
     * discovered (a moved port, dual-stack bind, etc.). Persisted so an UNHEALTHY
     * announcement cites the URL that actually got probed.
     */
    probeUrl?: string;
    /**
     * ms timestamp of the LAST real HTTP response < 500. Undefined = the server
     * has never answered a health probe. This is the escalation clock: nothing
     * is ever declared UNHEALTHY while this is fresh, no matter what the latest
     * single probe said.
     */
    lastGoodAt?: number;
    /** Kind of the most recent failed probe (for richer messages). */
    lastFail?: HttpProbeKind | "err";
    /** UNHEALTHY already announced for the current bad episode. */
    reportedUnhealthy?: boolean;
    /** STALLED already announced for the current quiet episode. */
    reportedStalled?: boolean;
    /** Last time we did an HTTP probe of this server (throttle). */
    lastProbeAt?: number;
}
/** State file for a handoff, named `<stem>-<ts>.state.json`. */
export declare function stateFilePath(dir: string, stem: string, ts: number): string;
/** Where the wrapper records the detached daemon's pid. */
export declare function pidFilePath(dir: string, stem: string, ts: number): string;
/** Persist the handoff marker synchronously; failures are deliberately silent. */
export declare function writeSidecar(statePath: string, sidecar: ServerSidecar): void;
/** True when at least one handoff is being tracked in `dir`. */
export declare function hasTrackedServers(dir: string): boolean;
export interface ProbeAnnouncement {
    severity: "died" | "stalled" | "unhealthy" | "recovered";
    pid: number;
    display: string;
    url?: string;
}
/** Announcements are returned as a list; buildProbeEcho renders them into `echo ...` lines. */
export declare function renderAnnouncement(a: ProbeAnnouncement): string;
/**
 * Scan the state dir and return every announcement for this bash call. Died
 * servers have their state + pid files removed (reported once and forgotten).
 */
export declare function probeServers(dir: string, cfg: ServerStartGuardConfig): Promise<ProbeAnnouncement[]>;
/**
 * Prepend the notifications to the real command. Produces ONLY literal
 * echo/Write-Output lines — there is no shell logic embedded, so nothing to
 * quote-bug. Returns `cmd` unchanged when there is nothing to say.
 */
export declare function buildProbeEcho(announcements: ProbeAnnouncement[], cmd: string, isWindows: boolean): string;
