import { Plugin } from "@opencode-ai/plugin";
import { readConfig } from "./config.js";
import { detect, resolveLogDir, rewrite } from "./rewrite.js";
import { buildProbeEcho, probeServers } from "./status.js";

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
export const ServerStartGuardPlugin: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash") return;

      const cfg = readConfig();
      if (!cfg.enabled) return;

      const command: unknown = output.args?.command;
      if (typeof command !== "string") return;

      const workdir: string | undefined =
        typeof output.args?.workdir === "string" ? output.args.workdir : undefined;

      let cmd = command;
      if (detect(command, cfg)) {
        cmd = rewrite(command, cfg, workdir);
      }

      // Every bash call (not just server starts) is a free chance to report
      // how previously-detached servers are doing. The probe runs in-process
      // (pid + log-staleness + optional HTTP health), then prepends only
      // literal echo/Write-Output lines announcing CHANGES.
      const dir = resolveLogDir(cfg);
      const announcements = await probeServers(dir, cfg);
      cmd = buildProbeEcho(announcements, cmd, isWindows());

      output.args.command = cmd;
    },
  };
};

function isWindows(): boolean {
  return typeof process !== "undefined" && process.platform === "win32";
}