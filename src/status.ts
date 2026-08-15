import * as fs from "node:fs";
import * as path from "node:path";

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
export const STALLED_MS = 2 * 60 * 1000;

export interface ServerSidecar {
  command: string;
  workdir: string;
  startedAt: string;
  outLog: string;
  errLog: string;
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
export function writeSidecar(
  statePath: string,
  sidecar: ServerSidecar,
): void {
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

/** Escape a string for safe inclusion inside single quotes in a POSIX shell. */
function shq(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/**
 * POSIX (mac/linux) probe. Reports and cleans up died servers; flags stalled
 * ones (pid alive, logs silent for STALLED_MS). `kill -0` for liveness and
 * `find -mmin` for mtime work identically on mac BSD and linux GNU, so this
 * is a single portable snippet.
 */
export function buildPosixProbe(stateDir: string): string {
  const sd = shq(stateDir);
  const m = Math.round(STALLED_MS / 60000);
  return (
    `for f in '${sd}'/*.state.json; do ` +
    `[ -e "$f" ] || continue; b="${'${f%.state.json}'}"; ` +
    `[ -f "$b.pid" ] || continue; p=$(cat "$b.pid" 2>/dev/null); ` +
    `case "$p" in ''|0|*[!0-9]*) continue;; esac; ` +
    `if kill -0 "$p" 2>/dev/null; then ` +
    `if { [ -f "$b.out.log" ] || [ -f "$b.err.log" ]; } && [ -z "$(find "$b.out.log" "$b.err.log" -mmin -${m} 2>/dev/null)" ]; then ` +
    `echo "[server-start-guard] server STALLED (pid $p, no log writes in ${m}m): $b"; fi; ` +
    `else echo "[server-start-guard] server DIED (pid $p): $b"; rm -f "$f" "$b.pid"; fi; ` +
    `done`
  );
}

/**
 * Windows (pwsh) probe — the mirror of buildPosixProbe: Get-Process for
 * liveness, LastWriteTime for staleness, Remove-Item for cleanup.
 */
export function buildWindowsProbe(stateDir: string): string {
  const sd = stateDir.replace(/'/g, "''");
  const m = Math.round(STALLED_MS / 60000);
  return (
    `foreach ($s in Get-ChildItem '${sd}' -Filter '*.state.json' -ErrorAction SilentlyContinue) { ` +
    `$b = $s.FullName -replace '\\.state.json$',''; ` +
    `$pidf = "\${b}.pid"; $p = 0; ` +
    `if (Test-Path -LiteralPath $pidf) { $raw = (Get-Content -LiteralPath $pidf -Raw).Trim(); if ($raw -match '\\d') { $p = [int]($raw -replace '\\D','') } }; ` +
    `if ($p -le 0) { continue }; ` +
    `if (Get-Process -Id $p -ErrorAction SilentlyContinue) { ` +
    `$logs = @("\${b}.out.log","\${b}.err.log") | Where-Object { Test-Path -LiteralPath $_ }; ` +
    `if ($logs.Count -gt 0) { ` +
    `$last = ($logs | ForEach-Object { (Get-Item -LiteralPath $_).LastWriteTime } | Sort-Object -Descending | Select-Object -First 1); ` +
    `if ($last -and (Get-Date) -gt $last.AddMinutes(${m})) { Write-Output "[server-start-guard] server STALLED (pid $p, no log writes in ${m}m): $b" } ` +
    `} } else { ` +
    `Write-Output "[server-start-guard] server DIED (pid $p): $b"; ` +
    `Remove-Item -LiteralPath "\${b}.pid","\${b}.state.json" -Force -ErrorAction SilentlyContinue ` +
    `} }`
  );
}

const IS_WINDOWS = typeof process !== "undefined" && process.platform === "win32";

/**
 * Build the probe snippet for the current platform, or "" when no handoff is
 * being tracked (so an idle agent pays nothing extra on every command).
 */
export function buildStatusProbe(stateDir: string): string {
  if (!hasTrackedServers(stateDir)) return "";
  return IS_WINDOWS ? buildWindowsProbe(stateDir) : buildPosixProbe(stateDir);
}