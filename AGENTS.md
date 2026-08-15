# Server Start Guard

opencode plugin that detects server-start commands issued to the `bash` tool and rewrites them into a detached `Start-Process pwsh -EncodedCommand ...` call with stdio redirected to log files, so the bash call returns immediately and the agent never freezes on an inherited output pipe. Windows-only.

## Critical: `dist/` is committed and is what runs

- Install flow (`install.bat`) copies only `dist/*` into `~/.config/opencode/plugins/server-start-guard/`. opencode loads the compiled plugin, not `src/`.
- After editing `src/`, you MUST run `npm run build` (`tsc` → `dist/`) and commit the resulting `dist/` changes together with the source. A stale `dist/` means the installed plugin silently runs old code. Prior commits (e.g. the `-NoProfile`/stdin fix) included the `dist` output alongside the `src` edit — follow that pattern.
- No lint, no tests, no CI. Verification = `npm run build` + a manual hook pass.
- `install.bat` holds the entire installer as a base64-encoded PowerShell script in `SSG_B64` (launched via `powershell.exe -EncodedCommand`, since Windows blocks untrusted `.ps1`). It requires the full release folder on disk — it copies `dist\*` from `%~dp0` and throws if `dist\index.js` is missing; it also registers the plugin in the global `opencode.jsonc`/`opencode.json` and seeds a default `config.json` if absent. To change installer behavior, edit that blob — there is no separate script file.

## Architecture

- Single hook: `tool.execute.before` in `src/index.ts`. Mutates `output.args.command` in place; only fires for tool id `bash`. MCP tools never route through bash and are intentionally untouched.
- Detection (`src/rewrite.ts`) is regex over `BASE_PATTERNS`, plus `extraPatterns` substring matches from config. `isAlreadySafe` skips only `Start-Process` invocations that redirect **all three** of stdout, stderr, AND stdin — a hand-written `Start-Process` that redirects just out+err still inherits the stdin pipe write-end and can hang, so it is NOT treated as safe and gets rewritten.
- Rewrite is additive: original command is preserved verbatim inside an encoded script (`Set-Location -LiteralPath '<workdir>'` + original command), base64 UTF-16LE via `-EncodedCommand` to avoid shell-quoting hazards.
- Detection is deliberately loose (any `npm run dev`, `vite`, etc. qualifies) — a one-shot command that merely *looks* like a server is an acceptable false positive, because the worst case is "output went to a log file instead of inline" and the command still runs verbatim. Don't narrow the patterns out of caution.

## Don't break the detachment primitive

The stdout/stderr/stdin redirection triad is load-bearing — an inherited write-end stdin pipe keeps the original bash call open (the exact hang this plugin exists to prevent). If you touch the rewrite:
- `-NoProfile` must be inside `-ArgumentList` (it was previously misplaced, causing the hang it was meant to fix).
- stdin redirect must point at a real empty file, not `NUL` — `Start-Process` rejects device paths.
- Log files derive from the first token of the command + timestamp, written to `cfg.logDir` (default `%TMP%\opencode\server-logs`).

## Config

Runtime config at `~/.config/opencode/plugins/server-start-guard/config.json`, re-read on every hook invocation — edits apply without an opencode restart. Keys: `enabled` (bool), `logDir` (string), `extraPatterns` (string[] of substrings). Absent/malformed config silently falls back to defaults. If the configured `logDir` can't be created, the rewrite silently falls back to the default `%TMP%\opencode\server-logs` — don't be surprised by logs landing there instead of the custom dir.

## Known issue (upstream, not this plugin)

On Windows a helper agent can still stay stuck after starting a server even though the detached server runs fine — that's an opencode-on-Windows problem, not a rewrite failure. See README "One known issue".