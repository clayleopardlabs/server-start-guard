import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ServerStartGuardConfig } from "./types.js";
import { isAlive } from "./pid.js";
import { hasLiveTrackedServers, scanOnce } from "./watch.js";


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
export function runnerScriptPath(): string {
  const current = fileURLToPath(import.meta.url);
  return path.join(path.dirname(current), "watchdog-runner.js");
}

function lockPath(dir: string): string {
  return path.join(dir, ".watchdog.pid");
}

/** True when a watchdog runner for this dir is already alive. */
export function watchdogRunning(dir: string): boolean {
  try {
    const raw = fs.readFileSync(lockPath(dir), "utf-8").trim();
    const m = raw.match(/\d+/);
    if (!m) return false;
    return isAlive(Number(m[0]));
  } catch {
    return false;
  }
}

/** Look a program up on PATH without spawning anything. */
function findOnPath(name: string): string | undefined {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return undefined;
}

/**
 * Resolve a JavaScript runtime that can execute the runner.
 *
 * `process.execPath` must NOT be used blindly: the plugin runs inside
 * opencode's compiled binary, so execPath is `opencode.exe`. Spawning that with
 * a `.js` argument starts a second copy of opencode, which never runs the
 * runner, so the watchdog silently does not exist (and leaves a stray process
 * behind). Only accept execPath when it really is node/bun.
 */
export function resolveRunnerRuntime(): string | undefined {
  const explicit = process.env.SSG_NODE_PATH;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const fromNpm = process.env.npm_node_execpath;
  if (fromNpm && fs.existsSync(fromNpm)) return fromNpm;

  const exe = path.basename(process.execPath).toLowerCase();
  if (exe === "node.exe" || exe === "node" || exe === "bun.exe" || exe === "bun") {
    return process.execPath;
  }

  return findOnPath("node") ?? findOnPath("bun");
}

/** In-process fallback runners, keyed by log dir. */
const inProcess = new Map<string, NodeJS.Timeout>();

/**
 * Log dirs where a spawned runner was seen to die immediately. The in-process
 * watch takes over for those, so the feature degrades instead of vanishing: a
 * detached child that exits at once (bad argv, unloadable module, missing
 * runtime) otherwise leaves no trace at all - its stdio is ignored.
 */
const runnerDead = new Set<string>();

/**
 * Last-resort watch that needs no child process: a single unref'd interval in
 * the plugin's own process. Only used when no runtime can be spawned, and it
 * stops itself once nothing is tracked.
 */
function ensureInProcessWatch(dir: string, cfg: ServerStartGuardConfig): void {
  if (inProcess.has(dir)) return;
  const timer = setInterval(() => {
    // Never let a scan failure escape: this runs inside the plugin host, where
    // an unhandled rejection is fatal.
    scanOnce({
      dir,
      stalledAfterMs: cfg.watchdogStalledAfterMs,
      healthTimeoutMs: cfg.healthTimeoutMs,
    }).catch(() => {});
    try {
      if (!hasLiveTrackedServers(dir)) {
        clearInterval(timer);
        inProcess.delete(dir);
      }
    } catch {
      clearInterval(timer);
      inProcess.delete(dir);
    }
  }, Math.max(cfg.watchdogPollMs, 1000));
  timer.unref?.();
  inProcess.set(dir, timer);
}

/**
 * Ensure a detached watchdog runner is watching `dir`. Returns the child when
 * one was spawned, undefined when a runner already existed, nothing is
 * tracked, or spawning was disabled.
 */
export function ensureWatchdog(
  dir: string,
  cfg: ServerStartGuardConfig,
): ChildProcess | undefined {
  if (!cfg.watchdogEnabled) return undefined;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return undefined;
  }
  // Nothing tracked means nothing to watch. Without this gate every bash call
  // in a fresh session would try to start a runner.
  if (!hasLiveTrackedServers(dir)) return undefined;
  if (runnerDead.has(dir)) {
    ensureInProcessWatch(dir, cfg);
    return undefined;
  }
  if (watchdogRunning(dir)) return undefined;

  const runner = runnerScriptPath();
  if (!fs.existsSync(runner)) return undefined;

  const runtime = resolveRunnerRuntime();
  if (!runtime) {
    ensureInProcessWatch(dir, cfg);
    return undefined;
  }

  // Options travel through a file, not argv: a JSON argument is fragile through
  // some spawn implementations on Windows, and a mangled one makes the runner
  // exit instantly with its stdio ignored, i.e. invisibly.
  try {
    fs.writeFileSync(
      path.join(dir, ".watchdog.json"),
      JSON.stringify({
        pollMs: cfg.watchdogPollMs,
        stalledAfterMs: cfg.watchdogStalledAfterMs,
        healthTimeoutMs: cfg.healthTimeoutMs,
        lockPath: lockPath(dir),
      }),
      "utf-8",
    );
  } catch {
    // the runner falls back to defaults
  }

  let child: ChildProcess;
  try {
    child = spawn(runtime, [runner, dir], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    ensureInProcessWatch(dir, cfg);
    return undefined;
  }

  // Spawn failures are asynchronous. Without a listener a missing runtime
  // would raise an uncaught exception inside the opencode process.
  child.on("error", () => {
    ensureInProcessWatch(dir, cfg);
  });
  child.unref();

  if (typeof child.pid === "number" && child.pid > 0) {
    const pid = child.pid;
    try {
      fs.writeFileSync(lockPath(dir), String(pid), "utf-8");
    } catch {
      // lock write failure: the runner still works, the next call may spawn a
      // duplicate that exits on its own lock check - acceptable
    }
    // A spawn can succeed and the child still die in its first milliseconds.
    // Verify once, off the hook's critical path, and hand over to the
    // in-process watch if it did not survive.
    setTimeout(() => {
      if (isAlive(pid)) return;
      runnerDead.add(dir);
      try {
        fs.unlinkSync(lockPath(dir));
      } catch {
        // already gone
      }
      ensureInProcessWatch(dir, cfg);
    }, 500).unref?.();
  } else {
    ensureInProcessWatch(dir, cfg);
  }
  return child;
}
