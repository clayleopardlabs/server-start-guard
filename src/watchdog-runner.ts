import * as fs from "node:fs";
import * as path from "node:path";
import { isAlive } from "./pid.js";
import { hasLiveTrackedServers, scanOnce } from "./watch.js";

/**
 * Detached watchdog runner - the only code path scheduled to run outside an
 * agent's tool call. Started by `ensureWatchdog` in watchdog.ts with stdio
 * ignored; reads its options from argv[2] (a JSON string). Never imported by
 * the main plugin (it is spawned, not linked), so nothing it does can pull the
 * agent into a hang.
 *
 * The actual scan lives in watch.ts and is shared with the in-process fallback,
 * so both paths reap servers by exactly the same rule.
 */

interface RunnerOptions {
  dir: string;
  pollMs: number;
  stalledAfterMs: number;
  healthTimeoutMs?: number;
  lockPath: string;
}

function readOptions(): RunnerOptions | undefined {
  const arg = process.argv[2] ?? "";
  // Two accepted forms: the directory (preferred) or a JSON blob (legacy).
  // The path form exists because a JSON argument is fragile through some spawn
  // implementations on Windows: quotes and backslashes get mangled, the runner
  // exits before it can log anything, and the watchdog silently does not exist.
  // Options then come from `<dir>/.watchdog.json`, written by the spawner.
  let raw: Partial<RunnerOptions> = {};
  let dir = "";
  if (arg.trimStart().startsWith("{")) {
    try {
      raw = JSON.parse(arg) as Partial<RunnerOptions>;
    } catch {
      return undefined;
    }
    dir = typeof raw.dir === "string" ? raw.dir : "";
  } else {
    dir = arg.trim();
  }
  if (!dir) return undefined;
  try {
    const fromFile = JSON.parse(
      fs.readFileSync(path.join(dir, ".watchdog.json"), "utf-8"),
    ) as Partial<RunnerOptions>;
    raw = { ...fromFile, ...raw };
  } catch {
    // no options file: defaults below
  }
  return {
    dir,
    pollMs: typeof raw.pollMs === "number" && raw.pollMs > 0 ? raw.pollMs : 10_000,
    stalledAfterMs:
      typeof raw.stalledAfterMs === "number" && raw.stalledAfterMs > 0
        ? raw.stalledAfterMs
        : 5 * 60 * 1000,
    healthTimeoutMs:
      typeof raw.healthTimeoutMs === "number" && raw.healthTimeoutMs > 0
        ? raw.healthTimeoutMs
        : 2000,
    lockPath:
      typeof raw.lockPath === "string" && raw.lockPath
        ? raw.lockPath
        : path.join(dir, ".watchdog.pid"),
  };
}

function releaseLock(opts: RunnerOptions): void {
  try {
    fs.unlinkSync(opts.lockPath);
  } catch {
    // already gone - fine
  }
}

/** True while at least one handoff is still being tracked. */

function main(): void {
  const opts = readOptions();
  if (!opts) process.exit(1);

  // Acquire the lock: if another runner holds it (alive), exit quietly so we
  // never double-kill or duplicate. The spawner wrote our pid optimistically;
  // a different live pid means a predecessor is still watching.
  try {
    const lockPid = Number(
      (fs.readFileSync(opts.lockPath, "utf-8").trim().match(/\d+/) || [])[0],
    );
    if (lockPid > 0 && lockPid !== process.pid && isAlive(lockPid)) {
      process.exit(0);
    }
    fs.writeFileSync(opts.lockPath, String(process.pid), "utf-8");
  } catch {
    // lock write failed - run anyway (single-instance is best-effort)
  }

  const poll = Math.max(opts.pollMs, 1000);
  const scan = (): void => {
    void scanOnce({
      dir: opts.dir,
      stalledAfterMs: opts.stalledAfterMs,
      healthTimeoutMs: opts.healthTimeoutMs,
    }).catch(() => {
      // a scan failure must never kill the runner
    });
  };

  const timer = setInterval(scan, poll);

  const finish = (): void => {
    clearInterval(timer);
    clearInterval(idleTimer);
    releaseLock(opts);
    process.exit(0);
  };
  process.on("SIGINT", finish);
  process.on("SIGTERM", finish);
  process.on("exit", () => releaseLock(opts));

  // Stop once nothing LIVE is tracked, so no idle process is left behind.
  // A sidecar for a dead server does not count: the lazy probe announces DIED
  // and removes it, and the runner must not outlive its usefulness waiting.
  const idleTimer = setInterval(() => {
    if (!hasLiveTrackedServers(opts.dir)) finish();
  }, poll);

  // First pass shortly after start.
  setTimeout(scan, 500);
}

main();
