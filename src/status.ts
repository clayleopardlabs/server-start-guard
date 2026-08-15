import * as fs from "node:fs";
import * as path from "node:path";
import { discoverBoundUrl, probeHttpAny, type HttpProbeKind } from "./health.js";
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
export const STALLED_MS = 2 * 60 * 1000;

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
export function stateFilePath(dir: string, stem: string, ts: number): string {
  return path.join(dir, `${stem}-${ts}.state.json`);
}

/** Where the wrapper records the detached daemon's pid. */
export function pidFilePath(dir: string, stem: string, ts: number): string {
  return path.join(dir, `${stem}-${ts}.pid`);
}

/** Persist the handoff marker synchronously; failures are deliberately silent. */
export function writeSidecar(statePath: string, sidecar: ServerSidecar): void {
  try {
    fs.writeFileSync(statePath, JSON.stringify(sidecar), "utf-8");
  } catch {
    // probe will simply not find this handoff
  }
}

/** True when at least one handoff is being tracked in `dir`. */
export function hasTrackedServers(dir: string): boolean {
  try {
    return fs
      .readdirSync(dir)
      .some((f) => f.toLowerCase().endsWith(".state.json"));
  } catch {
    return false;
  }
}

export interface ProbeAnnouncement {
  severity: "died" | "stalled" | "unhealthy" | "recovered";
  pid: number;
  display: string;
  url?: string;
}

function readSidecar(statePath: string): ServerSidecar | undefined {
  try {
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as ServerSidecar;
  } catch {
    return undefined;
  }
}

function readPid(pidPath: string): number {
  try {
    const raw = fs.readFileSync(pidPath, "utf-8").trim();
    const m = raw.match(/\d+/);
    return m ? Number(m[0]) : 0;
  } catch {
    return 0;
  }
}

/**
 * Cross-platform pid existence check entirely in-process. ESRCH = gone;
 * EPERM (exists but not ours) counts as alive.
 */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Newest LastWriteTime among the server's existing log files, or 0. */
function newestLogWrite(sidecar: ServerSidecar): number {
  let newest = 0;
  for (const log of [sidecar.outLog, sidecar.errLog]) {
    try {
      const t = fs.statSync(log).mtimeMs;
      if (t > newest) newest = t;
    } catch {
      // log file may not exist yet after a fresh detach
    }
  }
  return newest;
}

/**
 * Effective URL to probe for a server: prefer the host:port the process
 * printed in its own logs (authoritative — a dev server that found its
 * requested port taken and moved is serving somewhere the rewrite guess
 * cannot know), else the rewrite-time guess, else nothing.
 */
function effectiveProbeUrl(sidecar: ServerSidecar): string | undefined {
  const discovered = discoverBoundUrl(sidecar.outLog, sidecar.errLog);
  return discovered ?? sidecar.probeUrl ?? sidecar.healthUrl;
}

async function probeOne(
  statePath: string,
  sidecar: ServerSidecar,
  pid: number,
  cfg: ServerStartGuardConfig,
): Promise<ProbeAnnouncement[]> {
  const now = Date.now();
  const display = statePath.replace(/\.state\.json$/i, "");
  const out: ProbeAnnouncement[] = [];

  if (!isAlive(pid)) {
    return [{ severity: "died", pid, display }];
  }

  let changed = false;

  // 1. Staleness: alive but silent for STALLED_MS -> STALLED once; recovery = RECOVERED.
  const newest = newestLogWrite(sidecar);
  if (newest > 0 && now - newest >= STALLED_MS) {
    if (!sidecar.reportedStalled) {
      sidecar.reportedStalled = true;
      changed = true;
      out.push({ severity: "stalled", pid, display });
    }
  } else if (sidecar.reportedStalled && newest > 0) {
    sidecar.reportedStalled = false;
    changed = true;
    out.push({ severity: "recovered", pid, display });
  }

  // 2. Active HTTP health — last-successful-response semantics. Only when a
  // probe URL is resolvable, past the boot grace period, throttled to one
  // probe per healthIntervalMs.
  const probeUrl = effectiveProbeUrl(sidecar);
  if (probeUrl) {
    const startedMs = Date.parse(sidecar.startedAt) || now;
    const ageOk = now - startedMs >= cfg.healthGraceMs;
    const throttle = sidecar.lastProbeAt === undefined || now - sidecar.lastProbeAt >= cfg.healthIntervalMs;
    if (ageOk && throttle) {
      const result = await probeHttpAny(probeUrl, cfg.healthTimeoutMs);
      sidecar.lastProbeAt = now;
      changed = true;

      if (result.kind === "ok") {
        // A real <500 response resets both the success clock and any episode.
        const wasUnhealthy = sidecar.reportedUnhealthy === true;
        sidecar.reportedUnhealthy = false;
        sidecar.lastGoodAt = now;
        sidecar.lastFail = undefined;
        if (wasUnhealthy) {
          out.push({ severity: "recovered", pid, display, url: probeUrl });
        }
      } else {
        sidecar.lastFail = result.kind;
        // Escalate ONLY by staleness of the last-successful-response clock —
        // never on a single probe. A slow recompile or a late boot ages the
        // clock; it does not turn one timeout into a diagnosis. For a server
        // that has never answered, the clock is pinned to the START of its
        // boot window (grace period), so a never-starting server does still
        // escalate once that whole window passes unserved.
        const baseline =
          sidecar.lastGoodAt !== undefined
            ? sidecar.lastGoodAt
            : startedMs + cfg.healthGraceMs;
        if (now - baseline >= STALLED_MS && !sidecar.reportedUnhealthy) {
          sidecar.reportedUnhealthy = true;
          out.push({
            severity: "unhealthy",
            pid,
            display,
            url: `${probeUrl} (${result.detail})`,
          });
        }
      }
    }
  }

  if (changed) writeSidecar(statePath, sidecar);
  return out;
}

/** Announcements are returned as a list; buildProbeEcho renders them into `echo ...` lines. */
export function renderAnnouncement(a: ProbeAnnouncement): string {
  switch (a.severity) {
    case "died":
      return `[server-start-guard] server DIED (pid ${a.pid}): ${a.display}`;
    case "stalled":
      return `[server-start-guard] server STALLED (pid ${a.pid}, no log writes in ${Math.round(STALLED_MS / 60000)}m): ${a.display}`;
    case "unhealthy":
      return `[server-start-guard] server UNHEALTHY (pid ${a.pid}, no good response in ${Math.round(STALLED_MS / 60000)}m): ${a.display} @ ${a.url}`;
    case "recovered":
      return a.url
        ? `[server-start-guard] server RECOVERED (pid ${a.pid}): ${a.display} @ ${a.url}`
        : `[server-start-guard] server RECOVERED (pid ${a.pid}): ${a.display}`;
  }
}

/**
 * Scan the state dir and return every announcement for this bash call. Died
 * servers have their state + pid files removed (reported once and forgotten).
 */
export async function probeServers(
  dir: string,
  cfg: ServerStartGuardConfig,
): Promise<ProbeAnnouncement[]> {
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const announcements: ProbeAnnouncement[] = [];
  for (const f of files) {
    if (!f.toLowerCase().endsWith(".state.json")) continue;
    const statePath = path.join(dir, f);
    const sidecar = readSidecar(statePath);
    if (!sidecar) continue;

    const pidPath = statePath.replace(/\.state\.json$/i, "") + ".pid";
    const pid = readPid(pidPath);
    // Wrapper may not have written the pid file yet on a very fresh detach.
    if (pid <= 0) continue;

    // Keep the effective probe URL synced with the authority (the process's
    // own logs) so a moved port is probed where the server actually is.
    const discovered = discoverBoundUrl(sidecar.outLog, sidecar.errLog);
    if (discovered && discovered !== sidecar.probeUrl) {
      sidecar.probeUrl = discovered;
      writeSidecar(statePath, sidecar);
    }

    const list = await probeOne(statePath, sidecar, pid, cfg);
    for (const ann of list) {
      announcements.push(ann);
      if (ann.severity === "died") {
        try {
          fs.unlinkSync(statePath);
          fs.unlinkSync(pidPath);
        } catch {
          // already gone — fine
        }
      }
    }
  }
  return announcements;
}

/**
 * Prepend the notifications to the real command. Produces ONLY literal
 * echo/Write-Output lines — there is no shell logic embedded, so nothing to
 * quote-bug. Returns `cmd` unchanged when there is nothing to say.
 */
export function buildProbeEcho(
  announcements: ProbeAnnouncement[],
  cmd: string,
  isWindows: boolean,
): string {
  if (announcements.length === 0) return cmd;
  const quotes = (s: string): string => (isWindows ? `'${s.replace(/'/g, "''")}'` : `'${s.replace(/'/g, `'\\''`)}'`);
  const lines = announcements.map((a) => (`${isWindows ? "Write-Output" : "echo"} ${quotes(renderAnnouncement(a))}`));
  return `${lines.join("; ")}; ${cmd}`;
}