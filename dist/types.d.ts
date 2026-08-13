export declare const PLUGIN_NAME = "server-start-guard";
/**
 * Runtime configuration file, re-read on every hook invocation so that a
 * config edit takes effect without restarting opencode. Mirrors the
 * mullvad-429-rotate convention: config lands at
 *   ~/.config/opencode/plugins/<name>/config.json
 */
export declare const CONFIG_PATH: string;
/** Default directory for detached server log files. */
export declare const DEFAULT_LOG_DIR: string;
export interface ServerStartGuardConfig {
    /** Global on/off switch. Set false to disable all rewrites. */
    enabled: boolean;
    /** Directory where detached server stdout/stderr logs are written. */
    logDir: string;
    /** Optional extra regex substrings of additional commands to treat as servers. */
    extraPatterns: string[];
}
