import * as os from "node:os";
import * as path from "node:path";
export const PLUGIN_NAME = "server-start-guard";
/**
 * Runtime configuration file, re-read on every hook invocation so that a
 * config edit takes effect without restarting opencode. Mirrors the
 * mullvad-429-rotate convention: config lands at
 *   ~/.config/opencode/plugins/<name>/config.json
 */
export const CONFIG_PATH = path.join(os.homedir(), ".config", "opencode", "plugins", PLUGIN_NAME, "config.json");
/** Default directory for detached server log files. */
export const DEFAULT_LOG_DIR = path.join(os.tmpdir(), "opencode", "server-logs");
//# sourceMappingURL=types.js.map