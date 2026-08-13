import type { ServerStartGuardConfig } from "./types.js";
/** True when a command string matches any server-start pattern. */
export declare function detect(command: string, cfg: ServerStartGuardConfig): boolean;
/**
 * Rewrites a server-start command into a detached, stdio-redirected form so
 * the original bash tool call returns immediately and never freezes on an
 * inherited output pipe. Achieved via a second pwsh process launched with
 * -EncodedCommand (base64, so no shell-quoting hazards), its stdout/stderr
 * redirected to per-invocation log files. On the shell used here (pwsh on
 * Windows) this is the reliable detachment primitive.
 */
export declare function rewrite(command: string, cfg: ServerStartGuardConfig, workdir: string | undefined): string;
