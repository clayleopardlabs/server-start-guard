# Server Start Guard

opencode plugin that detects server-start commands issued to the `bash` tool and rewrites them into a detached form with stdio redirected to log files, so the bash call returns immediately and the agent never freezes on an inherited output pipe. Cross-platform: Windows (pwsh) and POSIX/mac/linux (`nohup sh -c`).

## Critical: `dist/` is committed and is what runs

- Install flow (`install.bat`) copies only `dist/*` into `~/.config/opencode/plugins/server-start-guard/`. opencode loads the compiled plugin, not `src/`.
- After editing `src/`, you MUST run `npm run build` (`tsc` → `dist/`) and commit the resulting `dist/` changes together with the source. A stale `dist/` means the installed plugin silently runs old code. Prior commits (e.g. the `-NoProfile`/stdin fix) included the `dist` output alongside the `src` edit — follow that pattern.
- No lint, no tests, no CI. Verification = `npm run build` + a manual hook pass.
- `install.bat` holds the entire installer as a base64-encoded PowerShell script in `SSG_B64` (launched via `powershell.exe -EncodedCommand`, since Windows blocks untrusted `.ps1`). It requires the full release folder on disk — it copies `dist\*` from `%~dp0` and throws if `dist\index.js` is missing; it also registers the plugin in the global `opencode.jsonc`/`opencode.json` and seeds a default `config.json` if absent. To change installer behavior, edit that blob — there is no separate script file. macOS/linux use `install.sh`, which does the same steps in bash (sed-based JSONC edit; hand-edit the config if the file's shape isn't recognized).

## Architecture

- Single hook: `tool.execute.before` in `src/index.ts`. Mutates `output.args.command` in place; only fires for tool id `bash`. MCP tools never route through bash and are intentionally untouched.
- Detection (`src/rewrite.ts`) is regex over `BASE_PATTERNS`, plus `extraPatterns` substring matches from config. `isAlreadySafe` skips only `Start-Process` invocations that redirect **all three** of stdout, stderr, AND stdin — a hand-written `Start-Process` that redirects just out+err still inherits the stdin pipe write-end and can hang, so it is NOT treated as safe and gets rewritten.
- Rewrite is additive: original command is preserved verbatim inside an encoded script (`Set-Location -LiteralPath '<workdir>'` + original command), base64 UTF-16LE via `-EncodedCommand` to avoid shell-quoting hazards.
- Talk about the **detachment primitive** instead of the Windows command form — it's platform-dispatched: Windows → `Start-Process pwsh -EncodedCommand` (base64 UTF-16LE) with `-RedirectStandard{Input,Output,Error}`; POSIX → `nohup sh -c '<cmd>' </dev/null >out 2>err &` with single-quote escaping (`'\''`), so no base64 needed. `IS_WINDOWS` in `src/rewrite.ts` selects the branch; `buildPosixCommand`/`buildWindowsCommand` are the pure builders (exported for testing).
- Detection is deliberately loose (any `npm run dev`, `vite`, etc. qualifies) — a one-shot command that merely *looks* like a server is an acceptable false positive, because the worst case is "output went to a log file instead of inline" and the command still runs verbatim. Don't narrow the patterns out of caution.

## Lazy status probes (`src/status.ts`)

On detach the rewrite seeds a sidecar: `<stem>-<ts>.state.json` (command, workdir, out/err log paths) plus a sibling `<stem>-<ts>.pid` written by the launched wrapper (`-PassThru; $p.Id | Out-File` on Windows, `$!` on POSIX), all in the same log dir. On EVERY subsequent `bash` call the hook prepends a probe snippet (`${probe}; <cmd>`) that scans the state dir and announces only transitions: `server DIED` (pid gone — reported once, then `.state.json` + `.pid` are removed) or `server STALLED` (pid alive but no log write for `STALLED_MS` = 2 min). Healthy servers are silent. No long-lived process is ever spawned — the agent's next bash command is the notification channel, and `buildStatusProbe` returns `""` (no prepend) when nothing is tracked.

- Sidecar path helpers: `stateFilePath`/`pidFilePath`; persistence is `writeSidecar` (write failures deliberately silent). Platform dispatch mirrors the rewrite: `buildWindowsProbe` (pwsh) / `buildPosixProbe` (`kill -0` + `find -mmin`, works on both mac BSD and linux GNU).
- **PowerShell string-interpolation gotcha (verified bug):** inside double quotes, `"$b.pid"` parses as the `.pid` *property* of `$b` (null) — not `$b` + ".pid" — so `$pidf` was empty, the pid never read, `$p` stayed 0 and the probe silently `continue`d past every entry. The emitted snippet MUST use braced form `"${b}.pid"`. From the TS side that means escaping the brace in the template literal: `` `\${b}.pid` `` — a bare `${b}` in TS interpolates the nonexistent JS var `b`. Both bugs are easy to reintroduce; the unit suite (`C:\Users\Omen\AppData\Local\Temp\opencode\ssg-status-unit.mjs`) asserts the braced literal is present.
- **Regex escape chain gotcha (verified bug):** the Windows probe strips `.state.json` with `` `-replace '\.state.json$',''` `` — the TS source needs TWO slashes (`` `'\\.state.json$'` ``) so exactly one lands in the emitted string. A double-escape (`\\\\.` in TS → `\\` in output) turns it into literal-backslash + wildcard, which never matches the ending and silently skips every entry. Unit test: emitted probe includes `'\.state.json$'`.
- Windows probe liveness = `Get-Process -Id $p`; staleness = `(Get-Item).LastWriteTime` older than 2 min. POSIX liveness = `kill -0 "$p"`; staleness = `find "$b.out.log" "$b.err.log" -mmin -2` empty.
- `resolveLogDir` in `src/rewrite.ts` is shared by rewrite + probe; if a configured `logDir` can't be created it falls back to `os.tmpdir()/opencode/server-logs`.

## Don't break the detachment primitive

The stdout/stderr/stdin redirection triad is load-bearing — an inherited write-end stdin pipe keeps the original bash call open (the exact hang this plugin exists to prevent). If you touch the rewrite:
- Windows: `-NoProfile` must be inside `-ArgumentList` (it was previously misplaced, causing the hang it was meant to fix).
- Windows: stdin redirect must point at a real empty file, not `NUL` — `Start-Process` rejects device paths. POSIX uses `</dev/null`, which is fine.
- The platform's already-safe check (`isAlreadySafe`) is the flip side: Windows skips only a `Start-Process` that redirects the full triad; POSIX skips only a `nohup` that already redirects a stream AND ends with `&`. A bare `nohup server` on POSIX is still rewritten (it inherits the tool's pipes).
- Log files derive from the first token of the command + timestamp, written to `cfg.logDir` (default `%TMP%\opencode\server-logs` on Windows, `os.tmpdir()/opencode/server-logs` on POSIX).
- WSL1 on this machine (`wsl -d Ubuntu`) is a real POSIX testbed for the `nohup` branch — no node inside WSL, so test the emitted command as a `.sh` file, not via `node`.

## Config

Runtime config at `~/.config/opencode/plugins/server-start-guard/config.json`, re-read on every hook invocation — edits apply without an opencode restart. Keys: `enabled` (bool), `logDir` (string), `extraPatterns` (string[] of substrings). Absent/malformed config silently falls back to defaults. If the configured `logDir` can't be created, the rewrite silently falls back to the default `%TMP%\opencode\server-logs` — don't be surprised by logs landing there instead of the custom dir.

## Known issue (upstream, not this plugin)

On Windows a helper agent can still stay stuck after starting a server even though the detached server runs fine — that's an opencode-on-Windows problem, not a rewrite failure. See README "One known issue".