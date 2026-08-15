import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ServerStartGuardConfig } from "./types.js";

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
 * Commands that may already be a safe, non-hanging server start. The whole
 * stdout/stderr/stdin triad must be redirected: an inherited stdin pipe (the
 * write-end) is what keeps the original bash call open, so a Start-Process
 * that redirects only output/error — like opencode agents hand-write far too
 * often — still hangs. We skip only fully-detached invocations so we do not
 * double-wrap them.
 */
function isAlreadySafe(command: string): boolean {
  if (!/\bStart-Process\b/i.test(command)) return false;
  return (
    /-RedirectStandardInput\b/i.test(command) &&
    /-RedirectStandardOutput\b/i.test(command) &&
    /-RedirectStandardError\b/i.test(command)
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
 * Rewrites a server-start command into a detached, stdio-redirected form so
 * the original bash tool call returns immediately and never freezes on an
 * inherited output pipe. Achieved via a second pwsh process launched with
 * -EncodedCommand (base64, so no shell-quoting hazards), its stdout/stderr
 * redirected to per-invocation log files. On the shell used here (pwsh on
 * Windows) this is the reliable detachment primitive.
 */
export function rewrite(
  command: string,
  cfg: ServerStartGuardConfig,
  workdir: string | undefined,
): string {
  let dir = cfg.logDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // if we cannot create the configured log dir, fall back to the default
    dir = path.join(os.tmpdir(), "opencode", "server-logs");
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // give up on a custom dir; the Start-Process redirect will fail loudly
    }
  }

  const cwd = typeof workdir === "string" && workdir.trim() !== "" ? workdir : process.cwd();
  const ts = Date.now();
  const outLog = path.join(dir, `${baseName(command)}-${ts}.out.log`);
  const errLog = path.join(dir, `${baseName(command)}-${ts}.err.log`);
  // stdin must be redirected too: an inherited write-end stdin pipe is what
  // keeps the original bash tool call open. Start-Process rejects device
  // paths (e.g. NUL), so give it a real empty file (like </dev/null).
  const inLog = path.join(dir, `${baseName(command)}-${ts}.in.txt`);
  fs.writeFileSync(inLog, "");

  // Script executes in a fresh pwsh: cd to workdir, then run the original
  // command verbatim. Encoded as UTF-16LE base64 (-EncodedCommand).
  const script = `Set-Location -LiteralPath '${cwd.replace(/'/g, "''")}'\r\n${command}`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");

  return (
    `Write-Output '[server-start-guard] detached server start -> ${outLog}'; ` +
    `Start-Process pwsh -ArgumentList '-NoProfile','-EncodedCommand',${encoded} ` +
    `-RedirectStandardInput '${inLog}' ` +
    `-RedirectStandardOutput '${outLog}' -RedirectStandardError '${errLog}'`
  );
}