import * as os from "node:os";
import * as path from "node:path";

export const PLUGIN_NAME = "server-start-guard";

/**
 * Runtime configuration file, re-read on every hook invocation so that a
 * config edit takes effect without restarting opencode. Mirrors the
 * mullvad-429-rotate convention: config lands at
 *   ~/.config/opencode/plugins/<name>/config.json
 */
export const CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "opencode",
  "plugins",
  PLUGIN_NAME,
  "config.json",
);

/** Default directory for detached server log files. */
export const DEFAULT_LOG_DIR = path.join(
  os.tmpdir(),
  "opencode",
  "server-logs",
);

export interface HealthCheckRule {
  /** Substring of the original command that this rule applies to. */
  pattern: string;
  /** URL to probe for functional liveness (e.g. http://localhost:5173). */
  url: string;
}

export interface ServerStartGuardConfig {
  /** Global on/off switch. Set false to disable all rewrites. */
  enabled: boolean;
  /** Directory where detached server stdout/stderr logs are written. */
  logDir: string;
  /**
   * Hard ceiling (ms) for the `timeout` argument of every `bash` tool call the
   * hook touches. The hook always forces `output.args.timeout = min(existing,
   * bashTimeoutMs)`, so no agent session can hang on a server-start or any other
   * command for longer than this. Prevents the "stuck for hours" failure even
   * when a process wrongly inherits the tool's output pipe.
   */
  bashTimeoutMs: number;
  /**
   * Timeout (ms) forced on a command the hook actually rewrites into a detached
   * form. The rewritten call must return almost instantly (it just launches a
   * detached process), so a short bound is insurance against a broken rewrite,
   * not a constraint on the server itself.
   */
  detachTimeoutMs: number;
  /** Enable the detached watchdog process that force-kills wedged servers. */
  watchdogEnabled: boolean;
  /** Watchdog poll interval (ms) while servers are tracked. */
  watchdogPollMs: number;
  /**
   * Kill a tracked server whose logs have been silent for this long (ms). The
   * watchdog is external to the agent: a separate detached node process scans
   * the state dir and force-kills such processes, writing a kill-note that the
   * next probe announces. Guards against orphaned/wedged servers holding ports
   * indefinitely.
   */
  watchdogStalledAfterMs: number;
  /**
   * Explicit path to the JavaScript runtime used to launch the detached
   * watchdog runner. Needed because opencode runs plugins with a stripped
   * PATH (measured: a single entry), so a PATH lookup for `node` finds
   * nothing and the watchdog silently degrades to the in-process timer. Empty
   * means "search the usual locations".
   */
  watchdogNodePath: string;
  /** Optional extra regex substrings of additional commands to treat as servers. */
  extraPatterns: string[];
  /**
   * Active HTTP health probes: per-command URL overrides. First rule whose
   * pattern is a substring of the command wins.
   */
  healthChecks: HealthCheckRule[];
  /** Relative seconds for a preset dev-server port map (true) or off (false). */
  defaultHealthChecks: boolean;
  /** Per-request timeout for an HTTP health probe, in milliseconds. */
  healthTimeoutMs: number;
  /** Minimum gap between health probes of the same server, in milliseconds. */
  healthIntervalMs: number;
  /** Grace period after start before the first probe, in milliseconds. */
  healthGraceMs: number;
}