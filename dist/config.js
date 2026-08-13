import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_LOG_DIR, CONFIG_PATH } from "./types.js";
function defaults() {
    return {
        enabled: true,
        logDir: DEFAULT_LOG_DIR,
        extraPatterns: [],
    };
}
/**
 * Reads the runtime config from CONFIG_PATH, falling back to defaults when
 * the file is absent or malformed. Re-read on every hook call so edits apply
 * without an opencode restart.
 */
export function readConfig() {
    const cfg = defaults();
    try {
        if (existsSync(CONFIG_PATH)) {
            const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
            if (typeof raw.enabled === "boolean")
                cfg.enabled = raw.enabled;
            if (typeof raw.logDir === "string" && raw.logDir.trim() !== "")
                cfg.logDir = raw.logDir;
            if (Array.isArray(raw.extraPatterns)) {
                cfg.extraPatterns = raw.extraPatterns.filter((p) => typeof p === "string");
            }
        }
    }
    catch {
        // malformed/unreadable config -> keep defaults
    }
    return cfg;
}
//# sourceMappingURL=config.js.map