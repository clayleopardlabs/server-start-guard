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
 * Windows (pwsh) rewrite: detach via a second pwsh launched with
 * -EncodedCommand (base64 UTF-16LE, so no shell-quoting hazards), its
 * stdout/stderr redirected to per-invocation log files. stdin must be
 * redirected too: an inherited write-end stdin pipe is what keeps the original
 * bash tool call open. Start-Process rejects device paths (e.g. NUL), so give
 * it a real empty file (like </dev/null). -PassThru + pid file let the status
 * probe track the launcher afterwards.
 */
export declare function buildWindowsCommand(command: string, outLog: string, errLog: string, inLog: string, cwd: string, pidPath: string): string;
/**
 * Rewrites a server-start command into a detached, stdio-redirected form so
 * the original bash tool call returns immediately and never freezes on an
 * inherited output pipe. Also seeds the status sidecar (state + pid file
 * paths) so `buildStatusProbe` can later tell the agent when the server
 * changes.
 */
export declare function rewrite(command: string, cfg: ServerStartGuardConfig, workdir: string | undefined): string;
