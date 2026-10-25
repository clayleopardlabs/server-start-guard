/**
 * The watchdog scan, shared by the detached runner (the normal path) and the
 * in-process fallback used when no JavaScript runtime can be spawned. One
 * implementation means the two paths cannot drift apart.
 */
export interface WatchOptions {
    dir: string;
    stalledAfterMs: number;
    /** Per-request HTTP timeout used to double-check a log-silent server. */
    healthTimeoutMs?: number;
    /** State files with no pid file are forgotten after this long. */
    orphanMs?: number;
}
/**
 * A sidecar with no pid file is forgotten after this long. Kept in step with
 * the lazy probe's orphan window (`status.ts` imports this constant) so the two
 * cannot disagree about whether a handoff is still real.
 */
export declare const DEFAULT_ORPHAN_MS: number;
/** Force-kill a process and its children. */
export declare function killTree(pid: number): void;
/**
 * True while at least one tracked server is worth watching: its pid is alive,
 * or its pid file has not appeared yet (a very fresh detach). A sidecar whose
 * pid is already dead is NOT tracked - the lazy probe owns the DIED
 * announcement, and keeping a runner alive just to watch a corpse leaves an
 * idle process behind after every server that has died.
 */
export declare function hasLiveTrackedServers(dir: string, orphanMs?: number): boolean;
/**
 * One scan of the state dir.
 *
 * A tracked server is killed only when it has been log-silent for
 * `stalledAfterMs` AND it is not answering HTTP. Log silence alone is not
 * evidence of a wedge: a healthy dev server with no traffic writes nothing,
 * so killing on silence alone would reap working servers.
 */
export declare function scanOnce(opts: WatchOptions): Promise<void>;
