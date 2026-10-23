import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAlive } from "./pid.js";
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
export function runnerScriptPath() {
    const current = fileURLToPath(import.meta.url);
    return path.join(path.dirname(current), "watchdog-runner.js");
}
function lockPath(dir) {
    return path.join(dir, ".watchdog.pid");
}
/** True when a watchdog runner for this dir is already alive. */
export function watchdogRunning(dir) {
    try {
        const raw = fs.readFileSync(lockPath(dir), "utf-8").trim();
        const m = raw.match(/\d+/);
        if (!m)
            return false;
        return isAlive(Number(m[0]));
    }
    catch {
        return false;
    }
}
/**
 * Ensure a detached watchdog runner is watching `dir`. Spawns via the current
 * node binary with stdio detached+ignored and `.unref()` so the child cannot
 * pin the opencode process or inherit its pipes. Returns the child when one was
 * spawned, undefined when a runner already existed or spawning was disabled.
 */
export function ensureWatchdog(dir, cfg) {
    if (!cfg.watchdogEnabled)
        return undefined;
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch {
        return undefined;
    }
    if (watchdogRunning(dir))
        return undefined;
    const runner = runnerScriptPath();
    if (!fs.existsSync(runner))
        return undefined;
    const options = JSON.stringify({
        dir,
        pollMs: cfg.watchdogPollMs,
        stalledAfterMs: cfg.watchdogStalledAfterMs,
        lockPath: lockPath(dir),
    });
    // If the runner dies without removing the lock, the stale pid check above
    // lets a future spawn replace it.
    const child = spawn(process.execPath, [runner, options], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
    });
    child.unref();
    try {
        fs.writeFileSync(lockPath(dir), String(child.pid ?? ""), "utf-8");
    }
    catch {
        // lock write failure: the runner will still work, but the next
        // ensureWatchdog may spawn a duplicate — acceptable
    }
    return child;
}
//# sourceMappingURL=watchdog.js.map