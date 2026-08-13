import { type ServerStartGuardConfig } from "./types.js";
/**
 * Reads the runtime config from CONFIG_PATH, falling back to defaults when
 * the file is absent or malformed. Re-read on every hook call so edits apply
 * without an opencode restart.
 */
export declare function readConfig(): ServerStartGuardConfig;
