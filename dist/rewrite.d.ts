import type { ServerStartGuardConfig } from "./types.js";
/** True when a command string matches any server-start pattern. */
export declare function detect(command: string, cfg: ServerStartGuardConfig): boolean;
/**
 * Resolve the effective log/state directory for a config, falling back to the
 * default when the configured one cannot be created. Shared by the rewrite
 * (writes logs + sidecars) and the status probe (reads them back).
 */
export declare function resolveLogDir(cfg: ServerStartGuardConfig): string;
/**
 * POSIX (mac/linux) rewrite: detach via `nohup sh -c ... </dev/null >log 2>log
 * &`. The original command travels inside single quotes (escape `'`), so no
 * shell-quoting hazard and no dependence on base64. Captures the background
 * job's pid into `pidPath` so the status probe can track it later.
 */
export declare function buildPosixCommand(command: string, outLog: string, errLog: string, cwd: string, pidPath: string): string;
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
export declare function buildWindowsCommand(command: string, outLog: string, errLog: string, cwd: string, pidPath: string): string;
/**
 * Rewrites a server-start command into a detached, stdio-redirected form so
 * the original bash tool call returns immediately and never freezes on an
 * inherited output pipe. Also seeds the status sidecar (state + pid file
 * paths) so `buildStatusProbe` can later tell the agent when the server
 * changes.
 */
export declare function rewrite(command: string, cfg: ServerStartGuardConfig, workdir: string | undefined): string;
