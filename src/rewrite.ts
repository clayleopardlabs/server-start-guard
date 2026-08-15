import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerStartGuardConfig } from "./types.js";
import { resolveHealthUrl } from "./health.js";
import { pidFilePath, stateFilePath, writeSidecar } from "./status.js";

/**
 * Detection + rewriting for server-start commands.
 *
 * Design intent (Design A — Rewriter):
 *   - Detection is CONSERVATIVE: only high-confidence server-start patterns
 *     are rewritten. A one-shot command that merely *looks* like a server is a
 *     false positive whose cost is "output went to a log file instead of
 *     inline", which is acceptable.
 *   - The rewrite is ADDITIVE: the original command is preserved verbatim and
 *     merely detached + stdio-redirected, so a mis-detected one-shot still
 *     runs correctly.
 */

/**
 * The detachment primitive is platform-specific:
 *   - Windows (pwsh):  Start-Process pwsh -EncodedCommand ... with
 *     -RedirectStandardInput/-Output/-Error. base64 UTF-16LE avoids
 *     shell-quoting hazards.
 *   - POSIX (mac/linux, bash/sh): single-quote-escape the original command
 *     and run it under `nohup sh -c '...' </dev/null >log 2>log &`. nohup
 *     ignores SIGHUP; /dev/null (not a device-path problem here) closes stdin;
 *     the `&` background job's redirected streams close the tool's pipe so the
 *     bash call returns immediately.
 */
const IS_WINDOWS = typeof process !== "undefined" && process.platform === "win32";

/** Escape a string for safe inclusion inside single quotes in a POSIX shell. */
function shq(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/**
 * Commands that may already be a safe, non-hanging server start:
 *   - Windows: Start-Process must redirect the whole stdout/stderr/stdin
 *     triad — an inherited stdin pipe (the write-end) is what keeps the
 *     original bash call open, so out+err-only still hangs.
 *   - POSIX: a nohup background job that already redirects a stream and ends
 *     with `&` is considered detached. A bare `nohup server` (no redirect, no
 *     `&`) is NOT — it still inherits the tool's pipes.
 */
function isAlreadySafe(command: string): boolean {
  if (IS_WINDOWS) {
    return (
      /\bStart-Process\b/i.test(command) &&
      /-RedirectStandardInput\b/i.test(command) &&
      /-RedirectStandardOutput\b/i.test(command) &&
      /-RedirectStandardError\b/i.test(command)
    );
  }
  return (
    /\bnohup\b/i.test(command) &&
    /[0-9]?[<>]/.test(command) &&
    /&\s*(?:#.*)?$/m.test(command)
  );
}

/** Conservative, high-confidence server-start patterns (case-insensitive). */
const BASE_PATTERNS: RegExp[] = [
  // Explicit daemonization markers
  /\bStart-Process\b/i,
  /\bnohup\b/i,
  // Command-level backgrounding (a trailing & )
  /[;&]\s*&\s*(?:#.*)?$/m,
  // Known long-running dev/server runners
  /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|preview)\b/i,
  /\b(?:npm|pnpm|yarn|bun)\s+start\b/i,
  /\buvicorn\b/i,
  /\bgunicorn\b/i,
  /\bflask\s+run\b/i,
  /django[\w.:/-]*\s+runserver\b/i,
  /\brunserver\b/i,
  /\bmanage\.py\s+runserver\b/i,
  /\bpython(?:3(?:\.\d+)?)?\s+-m\s+(?:http\.server|uvicorn|flask|django)\b/i,
  /\bpython(?:3(?:\.\d+)?)?\s+[\w./\\-]*(?:server|app|serve)\.py\b/i,
  /\bnode\s+[\w./\\-]*(?:server|app|main)[\w.-]*\.(?:js|mjs|cjs|ts|mts|cts)\b/i,
  /\bgo\s+run\s+[\w./\\-]*server\.go\b/i,
  /\bdotnet\s+run\b/i,
  /\bjava\s+-jar\b/i,
  /\bdocker[- ]compose\s+up\b/i,
  /\bng\s+serve\b/i,
  /\bngrok\b/i,
  /\bvite\b/i,
  /\bnext\s+dev\b/i,
  /\bastro\s+dev\b/i,
  /\bwebpack(\s+serve|-(?:dev-server|serve))\b/i,
  /\b\.\/(?:dev|server|serve|launch|run|start)[\w./\\-]*\.(?:sh|bat|cmd)\b/i,
];

/** True when a command string matches any server-start pattern. */
export function detect(command: string, cfg: ServerStartGuardConfig): boolean {
  if (command.trim() === "") return false;
  if (isAlreadySafe(command)) return false;
  if (BASE_PATTERNS.some((re) => re.test(command))) return true;
  if (cfg.extraPatterns.some((p) => p && command.includes(p))) return true;
  return false;
}

/** Derive a log-file basename from the command's first meaningful token. */
function baseName(command: string): string {
  const m = command.trim().match(/["']?([^"'\s\\/]+)["']?/);
  const tok = m ? m[1] : "server";
  const ext = path.extname(tok);
  const stem = ext ? tok.slice(0, -ext.length) : tok;
  return (stem || "server").replace(/[^a-zA-Z0-9_-]/g, "-");
}

/**
 * Resolve the effective log/state directory for a config, falling back to the
 * default when the configured one cannot be created. Shared by the rewrite
 * (writes logs + sidecars) and the status probe (reads them back).
 */
export function resolveLogDir(cfg: ServerStartGuardConfig): string {
  let dir = cfg.logDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    dir = path.join(os.tmpdir(), "opencode", "server-logs");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // give up on a custom dir; the redirect will fail loudly
    }
  }
  return dir;
}

/**
 * POSIX (mac/linux) rewrite: detach via `nohup sh -c ... </dev/null >log 2>log
 * &`. The original command travels inside single quotes (escape `'`), so no
 * shell-quoting hazard and no dependence on base64. Captures the background
 * job's pid into `pidPath` so the status probe can track it later.
 */
export function buildPosixCommand(
  command: string,
  outLog: string,
  errLog: string,
  cwd: string,
  pidPath: string,
): string {
  return (
    `echo '[server-start-guard] detached server start -> ${shq(outLog)}'; ` +
    `cd '${shq(cwd)}' && nohup sh -c '${shq(command)}' ` +
    `</dev/null >'${shq(outLog)}' 2>'${shq(errLog)}' & PID=$!; ` +
    `echo "$PID" > '${shq(pidPath)}'`
  );
}

/**
 * Windows (pwsh) rewrite: detach via a second pwsh launched with
 * -EncodedCommand (base64 UTF-16LE, so no shell-quoting hazards), its
 * stdout/stderr redirected to per-invocation log files. stdin must be
 * redirected too: an inherited write-end stdin pipe is what keeps the original
 * bash tool call open. Start-Process rejects device paths (e.g. NUL), so give
 * it a real empty file (like </dev/null). -PassThru + pid file let the status
 * probe track the launcher afterwards.
 */
export function buildWindowsCommand(
  command: string,
  outLog: string,
  errLog: string,
  inLog: string,
  cwd: string,
  pidPath: string,
): string {
  // Script executes in a fresh pwsh: cd to workdir, then run the original
  // command verbatim. Encoded as UTF-16LE base64 (-EncodedCommand).
  const script = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'\r\n${command}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return (
    `Write-Output '[server-start-guard] detached server start -> ${outLog}'; ` +
    `$p = Start-Process pwsh -ArgumentList '-NoProfile','-EncodedCommand',${encoded} ` +
    `-RedirectStandardInput '${inLog}' ` +
    `-RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}' ` +
    `-PassThru; $p.Id | Out-File -Encoding 'ascii' '${pidPath}'`
  );
}

/**
 * Rewrites a server-start command into a detached, stdio-redirected form so
 * the original bash tool call returns immediately and never freezes on an
 * inherited output pipe. Also seeds the status sidecar (state + pid file
 * paths) so `buildStatusProbe` can later tell the agent when the server
 * changes.
 */
export function rewrite(
  command: string,
  cfg: ServerStartGuardConfig,
  workdir: string | undefined,
): string {
  const dir = resolveLogDir(cfg);

  const cwd =
    typeof workdir === "string" && workdir.trim() !== ""
      ? workdir
      : process.cwd();
  const ts = Date.now();
  const stem = baseName(command);
  const outLog = path.join(dir, `${stem}-${ts}.out.log`);
  const errLog = path.join(dir, `${stem}-${ts}.err.log`);
  const pidPath = pidFilePath(dir, stem, ts);

  const healthUrl = resolveHealthUrl(command, cfg);

  writeSidecar(stateFilePath(dir, stem, ts), {
    command,
    workdir: cwd,
    startedAt: new Date().toISOString(),
    outLog,
    errLog,
    ...(healthUrl ? { healthUrl } : {}),
  });

  if (IS_WINDOWS) {
    const inLog = path.join(dir, `${stem}-${ts}.in.txt`);
    fs.writeFileSync(inLog, "");
    return buildWindowsCommand(command, outLog, errLog, inLog, cwd, pidPath);
  }
  return buildPosixCommand(command, outLog, errLog, cwd, pidPath);
}