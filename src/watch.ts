import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { isAlive, isAliveStrict } from "./pid.js";
import { discoverBoundUrl, probeHttpAny } from "./health.js";
import { writeKillNote } from "./killnote.js";

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
export const DEFAULT_ORPHAN_MS = 2 * 60 * 1000;

/** Force-kill a process and its children. */
export function killTree(pid: number): void {
  if (!Number.isFinite(pid) || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      // taskkill exits non-zero when the pid is already gone - acceptable
    }
    return;
  }
  // POSIX: kill the whole process group when the job leads one (setsid is used
  // by buildPosixCommand when available). process.kill(-pid) throws when no
  // such group exists, which is the macOS case.
  try {
    process.kill(-pid, "SIGKILL");
    return;
  } catch {
    // no process group with that id - fall through
  }
  try {
    execFileSync("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" });
  } catch {
    // pkill absent or nothing matched - acceptable
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone - acceptable
  }
}

function newestWriteAcross(sidecar: { outLog: string; errLog: string }): number {
  let newest = 0;
  for (const log of [sidecar.outLog, sidecar.errLog]) {
    try {
      const t = fs.statSync(log).mtimeMs;
      if (t > newest) newest = t;
    } catch {
      // absent log
    }
  }
  return newest;
}

/**
 * True while at least one tracked server is worth watching: its pid is alive,
 * or its pid file has not appeared yet (a very fresh detach). A sidecar whose
 * pid is already dead is NOT tracked - the lazy probe owns the DIED
 * announcement, and keeping a runner alive just to watch a corpse leaves an
 * idle process behind after every server that has died.
 */
export function hasLiveTrackedServers(
  dir: string,
  orphanMs = DEFAULT_ORPHAN_MS,
): boolean {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return false;
  }
  const now = Date.now();
  for (const f of files) {
    if (!f.toLowerCase().endsWith(".state.json")) continue;
    const statePath = path.join(dir, f);
    const pidPath = statePath.replace(/\.state\.json$/i, "") + ".pid";
    let pid = 0;
    try {
      const m = fs.readFileSync(pidPath, "utf-8").match(/\d+/);
      pid = m ? Number(m[0]) : 0;
    } catch {
      // No pid file: fresh detach (still booting) or orphan.
      try {
        if (now - fs.statSync(statePath).mtimeMs < orphanMs) return true;
      } catch {
        // state vanished - ignore
      }
      continue;
    }
    if (pid > 0 && isAlive(pid)) return true;
  }
  return false;
}

/**
 * One scan of the state dir.
 *
 * A tracked server is killed only when it has been log-silent for
 * `stalledAfterMs` AND it is not answering HTTP. Log silence alone is not
 * evidence of a wedge: a healthy dev server with no traffic writes nothing,
 * so killing on silence alone would reap working servers.
 */
const DBG = process.env.SSG_DEBUG === "1";
const dbg = (...a: unknown[]): void => {
  if (DBG) console.error("[ssg-watch]", ...a);
};

export async function scanOnce(opts: WatchOptions): Promise<void> {
  let files: string[];
  try {
    files = fs.readdirSync(opts.dir);
  } catch {
    return;
  }

  const now = Date.now();
  const orphanMs = opts.orphanMs ?? DEFAULT_ORPHAN_MS;

  for (const f of files) {
    if (!f.toLowerCase().endsWith(".state.json")) continue;
    const statePath = path.join(opts.dir, f);
    const base = statePath.replace(/\.state\.json$/i, "");
    const pidPath = base + ".pid";

    let stateMtime = 0;
    try {
      stateMtime = fs.statSync(statePath).mtimeMs;
    } catch {
      continue;
    }

    let pid = 0;
    try {
      const m = fs.readFileSync(pidPath, "utf-8").match(/\d+/);
      pid = m ? Number(m[0]) : 0;
    } catch {
      // No pid file. A very fresh detach has not written it yet; an orphan
      // (denied permission prompt, aborted call) never will.
      if (now - stateMtime >= orphanMs) {
        try {
          fs.unlinkSync(statePath);
        } catch {
          // already gone - fine
        }
      }
      continue;
    }
    if (pid <= 0) continue;
    if (!isAlive(pid)) {
      // Dead already; the lazy probe owns the DIED announcement.
      continue;
    }

    let command = "";
    let outLog = "";
    let errLog = "";
    let probeUrl: string | undefined;
    let healthSource: "config" | "preset" | "log" | undefined;
    let everAnswered = false;
    try {
      const sc = JSON.parse(fs.readFileSync(statePath, "utf-8")) as {
        command?: unknown;
        outLog?: unknown;
        errLog?: unknown;
        probeUrl?: unknown;
        healthUrl?: unknown;
        healthSource?: unknown;
        lastGoodAt?: unknown;
      };
      command = typeof sc.command === "string" ? sc.command : "";
      outLog = typeof sc.outLog === "string" ? sc.outLog : "";
      errLog = typeof sc.errLog === "string" ? sc.errLog : "";
      probeUrl =
        (typeof sc.probeUrl === "string" && sc.probeUrl) ||
        (typeof sc.healthUrl === "string" && sc.healthUrl) ||
        undefined;
      healthSource =
        sc.healthSource === "preset" ||
        sc.healthSource === "config" ||
        sc.healthSource === "log"
          ? sc.healthSource
          : undefined;
      everAnswered = typeof sc.lastGoodAt === "number" && sc.lastGoodAt > 0;
    } catch {
      continue;
    }

    const newest = newestWriteAcross({ outLog, errLog });
    if (newest === 0) {
      // No log ever written - still booting; do not kill yet.
      continue;
    }
    dbg("tracked", base, "pid", pid, "silentMs", now - newest);
    if (now - newest < opts.stalledAfterMs) continue;

    // Log-silent. Ask the server before killing it: a quiet but answering
    // process is healthy, not wedged. A 5xx still means something is listening
    // and answering (the lazy probe reports that as UNHEALTHY); only a refused
    // connection or a timeout counts as "not answering".
    const discovered = discoverBoundUrl(outLog, errLog);
    const url = discovered ?? probeUrl;
    if (url) {
      const health = await probeHttpAny(url, opts.healthTimeoutMs ?? 2000);
      if (health.kind === "ok" || health.kind === "broken") continue;
      // A refused/timed-out GUESSED preset port is not evidence of a sick
      // server - a dev server that moved ports looks exactly like this.
      if (!discovered && healthSource === "preset" && !everAnswered) continue;
    }

    dbg("killing", pid, "url", url, "source", healthSource, "everAnswered", everAnswered);
    killTree(pid);
    // taskkill returns before Windows has finished tearing the process down, and
    // a terminated process whose handle is still open elsewhere keeps answering
    // process.kill(pid, 0). A single 250 ms check therefore reports "still
    // alive", the sidecar is kept, and the kill later looks like a DIED with the
    // KILLED note lost. Poll with the accurate check instead.
    let gone = false;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const strictAlive = isAliveStrict(pid);
      dbg("verify", i, "pid", pid, "alive", strictAlive);
      if (!strictAlive) {
        gone = true;
        break;
      }
    }
    if (!gone) {
      // The pid still answers. If the service behind it does not, the kill did
      // stop the service; otherwise keep the sidecar and retry next poll.
      if (!url) continue;
      const after = await probeHttpAny(url, opts.healthTimeoutMs ?? 2000);
      if (after.kind === "ok" || after.kind === "broken") continue;
    }

    dbg("kill verified, pid gone:", gone);
    try {
      fs.unlinkSync(statePath);
    } catch {
      // already gone - fine
    }
    try {
      fs.unlinkSync(pidPath);
    } catch {
      // already gone - fine
    }
    writeKillNote(statePath, {
      pid,
      command,
      display: base,
      stalledMs: now - newest,
      killedAt: new Date().toISOString(),
    });
  }
}
