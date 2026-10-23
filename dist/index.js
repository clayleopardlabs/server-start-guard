import { readConfig } from "./config.js";
import { detect, resolveLogDir, rewrite } from "./rewrite.js";
import { buildProbeEcho, probeServers, readKillNotes } from "./status.js";
import { ensureWatchdog } from "./watchdog.js";
/**
 * server-start-guard — enforces the "never start a server in the foreground"
 * rule mechanically. Detects server-start commands in the `bash` tool and
 * rewrites them into a detached + stdio-redirected form so the bash call
 * returns immediately and no agent ever freezes on an inherited output pipe.
 *
 * Design A (Rewriter): a `tool.execute.before` hook mutating `output.args`
 * in place (the SAME object reference the bash tool later reads) — verified
 * from opencode source (session/tools.ts) that the mutation reaches the
 * executed command, and that a thrown error blocks the spawn entirely.
 *
 * Scope: ONLY the `bash` tool (matched by tool id). MCP servers expose their
 * own tools (`ghidra-mcp_*`, `lmstudio-mcp_*`, ...) that never route through
 * bash, so MCP usage is untouched.
 *
 * Observability (lazy status): each rewrite seeds a sidecar, and on later bash
 * calls the hook prepends a probe that announces died / stalled servers. No
 * long-lived process is spawned — the agent's next bash command is the
 * notification channel. `buildStatusProbe` no-ops when nothing is tracked.
 *
 * Gated by an `enabled` flag in the runtime config so it can be disabled if
 * it ever misbehaves.
 */
export const ServerStartGuardPlugin = async () => {
    return {
        "tool.execute.before": async (input, output) => {
            if (input.tool !== "bash")
                return;
            const cfg = readConfig();
            if (!cfg.enabled)
                return;
            const command = output.args?.command;
            if (typeof command !== "string")
                return;
            const workdir = typeof output.args?.workdir === "string" ? output.args.workdir : undefined;
            let cmd = command;
            if (detect(command, cfg)) {
                cmd = rewrite(command, cfg, workdir);
                // A rewritten command must return almost immediately. This bound is
                // insurance against a broken rewrite, not a cap on the server itself.
                output.args.timeout = cfg.detachTimeoutMs;
            }
            else {
                // Hard timeout enforcement (the external stuck-guard): cap the bash
                // tool's timeout so NO command can run unbounded and freeze the session
                // for hours — even one that escapes the rewrite or inherits the tool's
                // pipe. applied to an explicit timeout (min) or forced when unset.
                const existing = typeof output.args?.timeout === "number" && output.args.timeout > 0
                    ? output.args.timeout
                    : Number.POSITIVE_INFINITY;
                output.args.timeout = Math.min(existing, cfg.bashTimeoutMs);
            }
            // Every bash call (not just server starts) is a free chance to report
            // how previously-detached servers are doing and to reconcile watchdog
            // kills. The probe runs in-process (pid + log-staleness + optional HTTP
            // health + kill-notes), then prepends only literal echo/Write-Output
            // lines announcing CHANGES.
            const dir = resolveLogDir(cfg);
            const announcements = await probeServers(dir, cfg);
            announcements.push(...readKillNotes(dir));
            cmd = buildProbeEcho(announcements, cmd, isWindows());
            // 1. Detached watchdog. Spawn (once per log dir) an external node process
            // that force-kills servers whose logs stay silent for
            // watchdogStalledAfterMs — regardless of whether the agent ever issues
            // another bash command. The watchdog runs with stdio ignored and .unref()
            // so it can never block an agent's tool pipe. Kill-notes it writes are
            // consumed above by readKillNotes on the next bash call.
            ensureWatchdog(dir, cfg);
            output.args.command = cmd;
        },
    };
};
function isWindows() {
    return typeof process !== "undefined" && process.platform === "win32";
}
//# sourceMappingURL=index.js.map