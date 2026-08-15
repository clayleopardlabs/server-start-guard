import { readConfig } from "./config.js";
import { detect, resolveLogDir, rewrite } from "./rewrite.js";
import { buildStatusProbe } from "./status.js";
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
            }
            // Every bash call (not just server starts) is a free chance to report
            // how previously-detached servers are doing.
            const dir = resolveLogDir(cfg);
            const probe = buildStatusProbe(dir);
            if (probe !== "") {
                cmd = `${probe}; ${cmd}`;
            }
            output.args.command = cmd;
        },
    };
};
//# sourceMappingURL=index.js.map