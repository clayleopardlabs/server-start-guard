import { type ChildProcess } from "node:child_process";
import type { ServerStartGuardConfig } from "./types.js";
/**
 * The external watchdog.
 *
 * Problem it solves: the lazy probe only runs inside a `bash` call. If the
 * agent goes away or stops issuing commands, a wedged server (alive but
 * silent — a recompile hang, a bound-but-deaf socket, a stray process) can sit
 * forever holding its port, invisible to the agent's next command. For the
 * "stuck for hours" failure the watch must exist OUTSIDE the agent.
 *
 * Solution: `ensureWatchdog` spawns a detached node process (the runner in
 * `watchdog-runner.ts`) with stdio fully ignored, so nothing it does can ever
 * block or be blocked by an agent's tool pipe. The runner scans the state dir
 * every `watchdogPollMs`; any tracked server whose logs have been silent for
 * `watchdogStalledAfterMs` is force-killed (taskkill /T on Windows to take the
 * whole tree, SIGKILL elsewhere) and a kill-note is written beside the state
 * file. The next probe reads kill-notes and announces them like any other
 * transition, then removes them. The runner exits when no state files remain,
 * so no idle process is left behind.
 *
 * Single-instance: a `.watchdog.pid` lock file in the log dir records the
 * runner's pid; `ensureWatchdog` reuses a live runner and only spawns one when
 * none is running.
 */
/** Absolute path to the compiled runner script (sibling of this module). */
export declare function runnerScriptPath(): string;
/** True when a watchdog runner for this dir is already alive. */
export declare function watchdogRunning(dir: string): boolean;
/**
 * Ensure a detached watchdog runner is watching `dir`. Spawns via the current
 * node binary with stdio detached+ignored and `.unref()` so the child cannot
 * pin the opencode process or inherit its pipes. Returns the child when one was
 * spawned, undefined when a runner already existed or spawning was disabled.
 */
export declare function ensureWatchdog(dir: string, cfg: ServerStartGuardConfig): ChildProcess | undefined;
