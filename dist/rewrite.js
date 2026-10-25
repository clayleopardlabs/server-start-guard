import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
 *   - Windows (pwsh): `Invoke-CimMethod -ClassName Win32_Process -MethodName
 *     Create` with an -EncodedCommand pwsh payload (base64 UTF-16LE, so no
 *     shell-quoting hazards). Win32_Process.Create runs the child with handle
 *     inheritance OFF, which is the whole point: `Start-Process
 *     -RedirectStandard*` opens the child with inheritance ON, so the child
 *     receives the bash tool's stdout pipe write-end as an extra handle and
 *     keeps the tool call open for as long as the server lives. Redirecting
 *     the std handles does not remove that extra handle. The payload redirects
 *     its own streams from inside (`& { <cmd> } 1> out 2> err`), so logs are
 *     still captured without any inherited pipe.
 *   - POSIX (mac/linux, bash/sh): single-quote-escape the original command
 *     and run it under `nohup sh -c '...' </dev/null >log 2>log &`. nohup
 *     ignores SIGHUP; /dev/null (not a device-path problem here) closes stdin;
 *     the `&` background job's redirected streams close the tool's pipe so the
 *     bash call returns immediately.
 */
const IS_WINDOWS = typeof process !== "undefined" && process.platform === "win32";
/** Escape a string for safe inclusion inside single quotes in a POSIX shell. */
function shq(s) {
    return s.replace(/'/g, `'\\''`);
}
/**
 * Commands that may already be a safe, non-hanging server start:
 *   - Windows: ONLY this plugin's own launcher (Win32_Process.Create). A
 *     hand-written `Start-Process ... -RedirectStandard*` is NOT safe: handle
 *     inheritance leaks the tool's stdout pipe write-end into the detached
 *     tree, so the bash call stays open while the server lives (measured: a
 *     4s child held a piped caller for 4.6s; the same child launched via
 *     Win32_Process.Create returned in 0.2s).
 *   - POSIX: a nohup background job that already redirects a stream and ends
 *     with `&` is considered detached. A bare `nohup server` (no redirect, no
 *     `&`) is NOT — it still inherits the tool's pipes.
 */
export function isAlreadySafe(command, isWindows = IS_WINDOWS) {
    if (isWindows) {
        return /Win32_Process/i.test(command) && /-MethodName\s+Create\b/i.test(command);
    }
    // The whole command must already be a detached background job: a nohup that
    // redirects BOTH streams AND ends with a single trailing `&`. The end-of-
    // command test is deliberate - a multi-line script whose first line is a
    // detached job and whose last line is a foreground server start is NOT safe.
    // Both streams matter: redirecting only stdout leaves stderr on the tool's
    // pipe (and vice versa), which holds the call open exactly like no redirect.
    const trimmed = command.trim();
    const endsBackground = /(?<![&>])&(?:\s*#.*)?\s*$/.test(trimmed);
    const hasNohup = /\bnohup\b/.test(trimmed);
    const both = /&>/.test(trimmed);
    const stdoutRedirected = both || /(?<![0-9&])>(?!&)\s*\S/.test(trimmed);
    const stderrRedirected = both || /2>&1|2>\s*\S/.test(trimmed);
    // `2>&1 > out.log` sends stderr to whatever stdout was BEFORE the redirect,
    // i.e. the tool's pipe - the same leak as redirecting only one stream.
    const errFirst = trimmed.search(/2>&1/);
    const outFirst = trimmed.search(/(?<![0-9&])>(?!&)/);
    const outOfOrder = errFirst >= 0 && outFirst >= 0 && errFirst < outFirst;
    return hasNohup && endsBackground && stdoutRedirected && stderrRedirected && !outOfOrder;
}
/**
 * Matches a shell command position: the start of the command, or the spot just
 * after a separator (`;`, `&&`, `||`, `|`, `(`, newline), plus leading
 * environment assignments and common wrappers (`sudo`, `npx`, `timeout 30`...).
 *
 * Without this anchor, a pattern like `/\bvite\b/` also fires on
 * `cat vite.config.ts`, `git log --grep vite` and `rg Start-Process`, and
 * silently moves a read-only command's output into a log file.
 */
const CMD_START = String.raw `(?:^|[;&|(\n]\s*)` +
    String.raw `(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|--?[\w-]+(?:=\S+)?|sudo(?:\s+-u\s+\S+)?|doas|npx|bunx|pnpx|env|exec|command|nice(?:\s+-n\s+\S+)?|cross-env|timeout\s+\S+|(?:ba|z|k)?sh\s+-[lc]+|cmd\s+/c|wsl(?:\s+(?:-\S+|--\S+)(?:\s+\S+)?)*\s+(?:--|-e|--exec)|wsl\s+\S+|(?:pnpm|yarn)\s+(?:exec|dlx))\s+)*` +
    String.raw `["']?` +
    String.raw `(?:(?:\.{1,2}[\\/]|[A-Za-z]:[\\/]|\\\\)[\w.\\/-]*[\\/])?`;
/** Anchor a program-name pattern to a command position. */
function atStart(source) {
    return new RegExp(CMD_START + source, "im");
}
/** Conservative, high-confidence server-start patterns (case-insensitive). */
const BASE_PATTERNS = [
    // Explicit daemonization / process-creation markers.
    atStart(String.raw `Start-Process\b`),
    atStart(String.raw `nohup\b`),
    // A single trailing `&` at the very end of the command (not `&&`, not `2>&1`).
    /(?<![&>])&(?:\s*#.*)?\s*$/,
    // Package-manager script runners.
    atStart(String.raw `(?:npm|pnpm|yarn|bun)\s+(?:--?[\w-]+(?:\s+\S+)?\s+)*(?:run\s+)?(?:dev|start|serve|preview|watch)\b`),
    atStart(String.raw `(?:npm|pnpm|yarn|bun)\s+run\s+dev:[\w-]+\b`),
    // Node / Python / Go / .NET / Java / Ruby / Elixir servers and watchers.
    atStart(String.raw `(?:nodemon|ts-node-dev|tsx\s+watch|node\s+--watch)\b`),
    atStart(String.raw `uvicorn\b`),
    atStart(String.raw `gunicorn\b`),
    atStart(String.raw `hypercorn\b`),
    atStart(String.raw `flask\s+(?:--app\s+\S+\s+)?run\b`),
    atStart(String.raw `django[\w.:/-]*\s+runserver\b`),
    atStart(String.raw `runserver\b`),
    atStart(String.raw `(?:[\w.\\/-]*[\\/])?(?:python(?:3(?:\.\d+)?)?\s+|py\s+)?(?:[\w.\\/-]*[\\/])?manage\.py\s+runserver\b`),
    atStart(String.raw `python(?:3(?:\.\d+)?)?\s+-m\s+(?:http\.server|uvicorn|flask|django)\b`),
    atStart(String.raw `python(?:3(?:\.\d+)?)?\s+[\w./\\-]*(?:server|app|serve)\.py\b`),
    atStart(String.raw `node\s+[\w./\\-]*(?:server|app|main)[\w.-]*\.(?:js|mjs|cjs|ts|mts|cts)\b`),
    atStart(String.raw `go\s+run\s+[\w./\\-]*server\.go\b`),
    atStart(String.raw `dotnet\s+(?:run|watch)\b`),
    atStart(String.raw `java\s+-jar\b`),
    atStart(String.raw `cargo\s+(?:run|watch)\b`),
    atStart(String.raw `mix\s+phx\.server\b`),
    atStart(String.raw `rails\s+(?:s|server)\b`),
    atStart(String.raw `php\s+-S\b`),
    // Static-file servers.
    atStart(String.raw `(?:http-server|live-server|serve)\b`),
    // Containers / tunnels.
    atStart(String.raw `docker[- ]compose\s+up\b`),
    atStart(String.raw `ngrok\b`),
    // Frontend dev servers.
    atStart(String.raw `ng\s+serve\b`),
    atStart(String.raw `vite\b`),
    atStart(String.raw `next\s+dev\b`),
    atStart(String.raw `nuxt\s+dev\b`),
    atStart(String.raw `astro\s+dev\b`),
    atStart(String.raw `webpack(\s+serve|-(?:dev-server|serve))\b`),
    atStart(String.raw `\.\/(?:dev|server|serve|launch|run|start)[\w./\\-]*\.(?:sh|bat|cmd)\b`),
];
/** True when a command string matches any server-start pattern. */
export function detect(command, cfg) {
    if (command.trim() === "")
        return false;
    if (isAlreadySafe(command))
        return false;
    if (BASE_PATTERNS.some((re) => re.test(command)))
        return true;
    if (cfg.extraPatterns.some((p) => p && command.includes(p)))
        return true;
    return false;
}
/** Derive a log-file basename from the command's first meaningful token. */
function baseName(command) {
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
export function resolveLogDir(cfg) {
    let dir = cfg.logDir;
    try {
        fs.mkdirSync(dir, { recursive: true });
    }
    catch {
        dir = path.join(os.tmpdir(), "opencode", "server-logs");
        try {
            fs.mkdirSync(dir, { recursive: true });
        }
        catch {
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
export function buildPosixCommand(command, outLog, errLog, cwd, pidPath) {
    // The pid is recorded by the CHILD, not from `$!` of the launching shell:
    // `$!` is the subshell that ran `cd ... && nohup ...`, so killing it leaves
    // the real server alive and still holding the port. `$$` inside the job is
    // the pid of the process that actually runs the command.
    const inner = `echo $$ > '${shq(pidPath)}'; ${command}`;
    // `setsid` (Linux/WSL) makes the job a session and process-group leader, so
    // the watchdog can kill the whole tree with `kill -<pid>`. macOS has no
    // setsid binary; there the runner falls back to pkill -P + kill.
    return (`echo '[server-start-guard] detached server start -> ${shq(outLog)}'; ` +
        `cd '${shq(cwd)}' || exit 1; ` +
        `if command -v setsid >/dev/null 2>&1; then SSG_SETSID=setsid; else SSG_SETSID=; fi; ` +
        `nohup $SSG_SETSID sh -c '${shq(inner)}' ` +
        `</dev/null >'${shq(outLog)}' 2>'${shq(errLog)}' &`);
}
/**
 * Windows (pwsh) rewrite: detach via `Win32_Process.Create`, whose child is
 * created with handle inheritance OFF. That is what makes the tool call return
 * immediately — `Start-Process -RedirectStandard*` inherits the tool's pipe
 * write-end, which keeps the call open until the server exits.
 *
 * Stdio is redirected by the payload itself (`& { <cmd> } 1> out 2> err`), and
 * the child is created with no inherited stdin, so nothing can hold the tool's
 * pipes open. The original command is preserved verbatim inside the encoded
 * script (base64 UTF-16LE), so PowerShell semantics and quoting are untouched.
 * -EncodedCommand needs no shell quoting, and the pid of the launched pwsh is
 * recorded so the probe and the watchdog can track and kill the whole tree.
 */
export function buildWindowsCommand(command, outLog, errLog, cwd, pidPath) {
    // Single quotes survive PowerShell parsing; double them for literal use.
    const q = (s) => s.replace(/'/g, "''");
    // Multi-line block so a trailing comment in the original command cannot
    // swallow the closing brace. Redirection lives inside the payload.
    const script = [
        "$ErrorActionPreference = 'Continue'",
        `Set-Location -LiteralPath '${q(cwd)}'`,
        "& {",
        command,
        `} 1> '${q(outLog)}' 2> '${q(errLog)}'`,
    ].join("\r\n");
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    // CreateProcess caps a command line at 32,767 characters and base64 UTF-16LE
    // is about 2.67x the source, so a very large command would fail inside
    // Win32_Process.Create. For those, write the payload to a .ps1 beside the
    // logs and launch it with -File (a locally created script still runs under
    // the machine's RemoteSigned policy).
    let launch = `pwsh -NoProfile -EncodedCommand ${encoded}`;
    if (encoded.length > 12000) {
        const scriptPath = outLog.replace(/\.out\.log$/i, ".ps1");
        try {
            fs.writeFileSync(scriptPath, script, "utf-8");
            launch = `pwsh -NoProfile -File '${q(scriptPath)}'`;
        }
        catch {
            // fall back to the encoded form; it may fail, but nothing is lost
        }
    }
    return (`Write-Output '[server-start-guard] detached server start -> ${q(outLog)}'; ` +
        `$ssg = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ ` +
        `CommandLine = '${q(launch)}'; ` +
        `CurrentDirectory = '${q(cwd)}' }; ` +
        `if ($ssg.ReturnValue -ne 0) { throw "server-start-guard: Win32_Process.Create failed ($($ssg.ReturnValue))" }; ` +
        `$ssg.ProcessId | Out-File -Encoding 'ascii' '${q(pidPath)}'`);
}
/**
 * Rewrites a server-start command into a detached, stdio-redirected form so
 * the original bash tool call returns immediately and never freezes on an
 * inherited output pipe. Also seeds the status sidecar (state + pid file
 * paths) so `buildStatusProbe` can later tell the agent when the server
 * changes.
 */
export function rewrite(command, cfg, workdir) {
    const dir = resolveLogDir(cfg);
    const cwd = typeof workdir === "string" && workdir.trim() !== ""
        ? workdir
        : process.cwd();
    // Two detaches of the same command inside one millisecond would otherwise
    // share a sidecar/pid/log set and overwrite each other.
    const stem = baseName(command);
    let ts = Date.now();
    while (fs.existsSync(stateFilePath(dir, stem, ts)) ||
        fs.existsSync(pidFilePath(dir, stem, ts))) {
        ts++;
    }
    const outLog = path.join(dir, `${stem}-${ts}.out.log`);
    const errLog = path.join(dir, `${stem}-${ts}.err.log`);
    const pidPath = pidFilePath(dir, stem, ts);
    const health = resolveHealthUrl(command, cfg);
    writeSidecar(stateFilePath(dir, stem, ts), {
        command,
        workdir: cwd,
        startedAt: new Date().toISOString(),
        outLog,
        errLog,
        ...(health ? { healthUrl: health.url, healthSource: health.source } : {}),
    });
    if (IS_WINDOWS) {
        return buildWindowsCommand(command, outLog, errLog, cwd, pidPath);
    }
    return buildPosixCommand(command, outLog, errLog, cwd, pidPath);
}
//# sourceMappingURL=rewrite.js.map