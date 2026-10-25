import { type ChildProcess } from "node:child_process";
import type { ServerStartGuardConfig } from "./types.js";
/**
 * The external watchdog.
 *
 * Problem it solves: the lazy probe only runs inside a `bash` call. If the
 * agent goes away or stops issuing commands, a wedged server (alive but
 * silent, or alive and answering nothing) can sit forever holding its port.
 * For the "stuck for hours" failure the watch must exist OUTSIDE the agent.
 *
 * Solution: `ensureWatchdog` spawns a detached JavaScript runtime running
 * `watchdog-runner.js` with stdio fully ignored, so nothing it does can ever
 * block or be blocked by an agent's tool pipe. The runner scans the state dir
 * every `watchdogPollMs`; a tracked server that has been log-silent for
 * `watchdogStalledAfterMs` AND is not answering HTTP is force-killed, and a
 * kill-note is written beside the state file. The next probe reads kill-notes
 * and announces them like any other transition, then removes them. The runner
 * exits when no state files remain, so no idle process is left behind.
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
 * Resolve a JavaScript runtime that can execute the runner.
 *
 * `process.execPath` must NOT be used blindly: the plugin runs inside
 * opencode's compiled binary, so execPath is `opencode.exe`. Spawning that with
 * a `.js` argument starts a second copy of opencode, which never runs the
 * runner, so the watchdog silently does not exist (and leaves a stray process
 * behind). Only accept execPath when it really is node/bun.
 */
export declare function resolveRunnerRuntime(): string | undefined;
/**
 * Ensure a detached watchdog runner is watching `dir`. Returns the child when
 * one was spawned, undefined when a runner already existed, nothing is
 * tracked, or spawning was disabled.
 */
export declare function ensureWatchdog(dir: string, cfg: ServerStartGuardConfig): ChildProcess | undefined;
