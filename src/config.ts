import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_LOG_DIR, CONFIG_PATH, type ServerStartGuardConfig } from "./types.js";

function defaults(): ServerStartGuardConfig {
  return {
    enabled: true,
    logDir: DEFAULT_LOG_DIR,
    extraPatterns: [],
    healthChecks: [],
    defaultHealthChecks: true,
    healthTimeoutMs: 2000,
    healthIntervalMs: 15000,
    healthGraceMs: 30000,
  };
}

/**
 * Reads the runtime config from CONFIG_PATH, falling back to defaults when
 * the file is absent or malformed. Re-read on every hook call so edits apply
 * without an opencode restart.
 */
export function readConfig(): ServerStartGuardConfig {
  const cfg = defaults();
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<ServerStartGuardConfig>;
      if (typeof raw.enabled === "boolean") cfg.enabled = raw.enabled;
      if (typeof raw.logDir === "string" && raw.logDir.trim() !== "") cfg.logDir = raw.logDir;
      if (Array.isArray(raw.extraPatterns)) {
        cfg.extraPatterns = raw.extraPatterns.filter((p) => typeof p === "string");
      }
      if (Array.isArray(raw.healthChecks)) {
        cfg.healthChecks = raw.healthChecks
          .filter((h) => h && typeof h === "object")
          .map((h) => ({
            pattern: typeof h.pattern === "string" ? h.pattern : "",
            url: typeof h.url === "string" ? h.url : "",
          }))
          .filter((h) => h.pattern !== "" && h.url !== "");
      }
      if (typeof raw.defaultHealthChecks === "boolean") cfg.defaultHealthChecks = raw.defaultHealthChecks;
      if (typeof raw.healthTimeoutMs === "number" && raw.healthTimeoutMs > 0) cfg.healthTimeoutMs = raw.healthTimeoutMs;
      if (typeof raw.healthIntervalMs === "number" && raw.healthIntervalMs > 0) cfg.healthIntervalMs = raw.healthIntervalMs;
      if (typeof raw.healthGraceMs === "number" && raw.healthGraceMs > 0) cfg.healthGraceMs = raw.healthGraceMs;
    }
  } catch {
    // malformed/unreadable config -> keep defaults
  }
  return cfg;
}