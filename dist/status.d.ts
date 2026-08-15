/**
 * Status probes — the lazy, cross-platform observability half of the guard.
 *
 * On detach the rewrite writes a `.state.json` sidecar (schema below) next to
 * the logs, and the launched wrapper records the daemon pid in a sibling
 * `<stem>-<ts>.pid` file. On EVERY subsequent bash call the hook prepends a
 * probe snippet (platform-dispatched like the rewrite) that scans the state
 * dir and announces only CHANGES worth knowing: a server that died, or one
 * that is still alive but stopped writing to its logs (the "returned then
 * went quiet" case that plain liveness misses).
 *
 * This preserves the plugin's fire-and-forget property: no long-lived process
 * is spawned. The agent's own next bash command is the notification channel,
 * so the probe is lazy (discovered then, not pushed) but costs a few
 * milliseconds and reports at exactly the moment the agent would otherwise
 * start checking itself.
 *
 * Dead servers are reported once and their state removed. Healthy servers are
 * silent — only transitions (died / stalled) are announced, so the guard
 * never spams "still running" on every command.
 */
/** Only announce "stalled" when NO log write happened for this window. */
export declare const STALLED_MS: number;
export interface ServerSidecar {
    command: string;
    workdir: string;
    startedAt: string;
    outLog: string;
    errLog: string;
}
/** State file for a handoff, named `<stem>-<ts>.state.json`. */
export declare function stateFilePath(dir: string, stem: string, ts: number): string;
/** Where the wrapper records the detached daemon's pid. */
export declare function pidFilePath(dir: string, stem: string, ts: number): string;
/** Persist the handoff marker synchronously; failures are deliberately silent. */
export declare function writeSidecar(statePath: string, sidecar: ServerSidecar): void;
/** True when at least one handoff is being tracked in `dir`. */
export declare function hasTrackedServers(dir: string): boolean;
/**
 * POSIX (mac/linux) probe. Reports and cleans up died servers; flags stalled
 * ones (pid alive, logs silent for STALLED_MS). `kill -0` for liveness and
 * `find -mmin` for mtime work identically on mac BSD and linux GNU, so this
 * is a single portable snippet.
 */
export declare function buildPosixProbe(stateDir: string): string;
/**
 * Windows (pwsh) probe — the mirror of buildPosixProbe: Get-Process for
 * liveness, LastWriteTime for staleness, Remove-Item for cleanup.
 */
export declare function buildWindowsProbe(stateDir: string): string;
/**
 * Build the probe snippet for the current platform, or "" when no handoff is
 * being tracked (so an idle agent pays nothing extra on every command).
 */
export declare function buildStatusProbe(stateDir: string): string;
