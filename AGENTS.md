# Server Start Guard

opencode plugin that detects server-start commands issued to the `bash` tool and rewrites them into a detached form with stdio redirected to log files, so the bash call returns immediately and the agent never freezes on an inherited output pipe. Cross-platform: Windows (pwsh) and POSIX/mac/linux (`nohup sh -c`).

## Critical: `dist/` is committed and is what runs

- Install flow (`install.bat`) copies only `dist/*` into `~/.config/opencode/plugins/server-start-guard/`. opencode loads the compiled plugin, not `src/`.
- After editing `src/`, you MUST run `npm run build` (`tsc` → `dist/`) and commit the resulting `dist/` changes together with the source. A stale `dist/` means the installed plugin silently runs old code. Prior commits (e.g. the `-NoProfile`/stdin fix) included the `dist` output alongside the `src` edit — follow that pattern.
- No lint, no CI. Verification = `npm run build` + `npm run verify` (Windows detach leak guard) + a manual hook pass. The committed `verify/` folder holds the portable subset; the wider 77-check suite was a session-local harness and is not committed.
- `install.bat` holds the entire installer as a base64-encoded PowerShell script in `SSG_B64` (launched via `powershell.exe -EncodedCommand`, since Windows blocks untrusted `.ps1`). It requires the full release folder on disk — it copies `dist\*` from `%~dp0` and throws if `dist\index.js` is missing; it also registers the plugin in the global `opencode.jsonc`/`opencode.json` and seeds a default `config.json` if absent. To change installer behavior, edit that blob — there is no separate script file. macOS/linux use `install.sh`, which does the same steps in bash (sed-based JSONC edit; hand-edit the config if the file's shape isn't recognized).

## Architecture

- Single hook: `tool.execute.before` in `src/index.ts`. Mutates `output.args.command` in place; only fires for tool id `bash`. MCP tools never route through bash and are intentionally untouched.
- Detection (`src/rewrite.ts`) is regex over `BASE_PATTERNS`, plus `extraPatterns` substring matches from config. `isAlreadySafe` skips ONLY this plugin's own Windows launcher (`Win32_Process` + `-MethodName Create`). A hand-written `Start-Process` is never treated as safe: its handle-inheritance leak is the exact hang this plugin exists to prevent, so it gets rewritten like any other server start.
- Rewrite is additive: the original command is preserved verbatim inside an encoded script (`Set-Location -LiteralPath '<workdir>'`, then `& { <command> } 1> out 2> err`), base64 UTF-16LE via `-EncodedCommand` to avoid shell-quoting hazards.
- Talk about the **detachment primitive** instead of the Windows command form — it's platform-dispatched: Windows → `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` running `pwsh -NoProfile -EncodedCommand <base64 UTF-16LE>`, with the payload redirecting its own stdout/stderr; POSIX → `nohup sh -c '<cmd>' </dev/null >out 2>err &` with single-quote escaping (`'\''`), so no base64 needed. `IS_WINDOWS` in `src/rewrite.ts` selects the branch; `buildPosixCommand`/`buildWindowsCommand` are the pure builders (exported for testing).
- Detection is deliberately loose (any `npm run dev`, `vite`, etc. qualifies) — a one-shot command that merely *looks* like a server is an acceptable false positive, because the worst case is "output went to a log file instead of inline" and the command still runs verbatim. Don't narrow the patterns out of caution.

## Lazy status probes (`src/status.ts`) — in-process, plus active HTTP health

On detach the rewrite seeds a sidecar: `<stem>-<ts>.state.json` (command, workdir, out/err log paths, optional `healthUrl`) plus a sibling `<stem>-<ts>.pid` written by the launched wrapper (`$ssg.ProcessId | Out-File` on Windows, `$!` on POSIX), all in the same log dir. On EVERY subsequent `bash` call the hook runs `probeServers(dir, cfg)` **inside the plugin's own Node process** (not as shell text) and prepends only literal `echo`/`Write-Output` lines via `buildProbeEcho`. No long-lived process is ever spawned — the agent's next bash command is the notification channel, and `buildProbeEcho` returns `cmd` unchanged when there's nothing to say.

- **The probe is Node code, not shell.** This is deliberate: shell probes could only do pid + mtime and carried a quoting surface (the two gotchas below are GONE — `buildWindowsProbe`/`buildPosixProbe`/`buildStatusProbe` no longer exist). Node gives us cross-platform liveness (`process.kill(pid, 0)`, EPERM counts alive) and, crucially, a real **HTTP health check** (`src/health.ts`). That check is the only thing that catches the state a pid check cannot: a process alive but serving 500s / answering nothing on every route.
- **Transitions only, episode-scoped, persisted in the sidecar** (`health` is gone — now `lastGoodAt`, `lastFail`, `reportedUnhealthy`, `probeUrl` fields, re-written by `writeSidecar`). UNHEALTHY is **last-successful-response based**, never a single-probe verdict:
  - `server DIED` — pid gone. Reported once, then `.state.json` + `.pid` are removed.
  - `server STALLED` — pid alive but no log write for `STALLED_MS` = 2 min. Announced once per quiet episode; a later log write flips back and announces `RECOVERED`.
  - `server UNHEALTHY` — pid alive and past boot grace, but **no real `<500` HTTP response for `STALLED_MS`** (the `lastGoodAt` clock). A lone timeout OR refused is recorded as `lastFail` but never escalates alone — recompiles and late boots age the clock without flipping it. For a server that has never answered, the clock is pinned to `startedAt + healthGraceMs` so a never-starting server still escalates. Announced once per bad episode; the next real `<500` response announces `RECOVERED`.
  - `server RECOVERED` — a previously STALLED/UNHEALTHY server is healthy again. Healthy servers are silent.
  - HTTP probing is throttled (`healthIntervalMs`, default 15 s) and gated by a boot grace (`healthGraceMs`, default 30 s) so a slow-starting server isn't flagged.
- **Health URL resolution (`src/health.ts`)** has four tiers, in priority: (1) the URL/port the server printed in its own logs (`discoverBoundUrl`, read from `outLog`/`errLog`, last match wins, loopback-only) — authoritative, because dev servers move ports when theirs is taken; (2) config `healthChecks` rules `[{pattern, url}]` — first substring match wins; (3) a built-in preset map of well-known dev-server ports (vite → 5173, ng → 4200, next/webpack → 3000, uvicorn/flask/django → 8000, etc.), opt-out via `defaultHealthChecks: false`; (4) none → pid/log monitoring only. A wrong guess costs one possibly-wrong UNHEALTHY report, never a bad rewrite.
- **Probing (`probeHttp`/`probeHttpAny`/`probeCandidates`)** returns a *classified* result, not a boolean: `ok` (<500, advances `lastGoodAt`), `broken` (>=500), `refused` (ECONNREFUSED — nothing listening), `timeout` (socket opened but no first response byte — the wedged/mid-recompile case). Every URL is probed across both loopback families (`localhost` expands to `127.0.0.1` + `::1` too; `0.0.0.0` maps to `127.0.0.1`), in parallel so total wait is one timeout, and any real response wins. Node's `fetch` wraps socket errors with the real code in `cause.code`, so `probeHttp` reads the code from either depth — do not "simplify" that back to `err.code` only.
- Sidecar path helpers: `stateFilePath`/`pidFilePath`; persistence is `writeSidecar` (write failures deliberately silent). Liveness is `process.kill(pid, 0)` with EPERM → alive; staleness is `fs.statSync().mtimeMs` on the out/err logs; health is `fetch` with an `AbortController` timeout (`healthTimeoutMs`, default 2 s). The emitted command is ONLY literal `echo`/`Write-Output` quoting (single-quote doubling on Windows, `'\''` on POSIX), so nothing is executed as shell logic.
- The old shell-probe gotchas (PowerShell `"$b.pid"` interpolation, the `\.state.json$` regex escape chain, `find -mmin` vs `LastWriteTime`) are moot — recorded here so nobody reintroduces shell probes. `buildStatusProbe` returning `""` was the old idle fast-path; the equivalent now is `probeServers` returning `[]` (no echo lines prepended).
- `resolveLogDir` in `src/rewrite.ts` is shared by rewrite + probe; if a configured `logDir` can't be created it falls back to `os.tmpdir()/opencode/server-logs`.

## Don't break the detachment primitive

The invariant is: **the detached process tree must inherit no handles from the tool's pipes.** "Redirect the std handles" is not the same thing, and redirecting all three does not remove the extra inherited write end.

Measured on this machine (4 s grandchild, caller's stdout piped, so a leak shows up as a ~4 s call):

| primitive | call returns in |
|---|---|
| `Start-Process` + `-RedirectStandard*` | 4620 ms (leak) |
| `Start-Process` without redirect params (ShellExecute) | 191 ms |
| `Win32_Process.Create` | 209 ms (267 ms end to end) |

`-RedirectStandard*` forces .NET's `UseShellExecute=false` path, which calls `CreateProcess` with handle inheritance on. libuv's pipe ends are inheritable, so the child receives the tool's stdout write end as an extra handle alongside its redirected std handles.

If you touch the rewrite:
- Windows: launch through `Invoke-CimMethod -ClassName Win32_Process -MethodName Create` (handle inheritance off) and redirect INSIDE the encoded payload (`& { <cmd> } 1> out 2> err`). Never go back to `Start-Process -RedirectStandard*`, and never "fix" it by adding more redirect flags: the extra inherited handle stays.
- Windows: the pid written to `<stem>-<ts>.pid` is the launched pwsh (`$ssg.ProcessId`). `taskkill /PID <pid> /T /F` takes the node child with it, which is what the watchdog relies on.
- POSIX: `nohup sh -c '<cmd>' </dev/null >out 2>err &` with single-quote escaping (`'\''`).
- The platform's already-safe check (`isAlreadySafe`) is the flip side: Windows recognises only the `Win32_Process` launcher; POSIX skips only a `nohup` that already redirects a stream AND ends with `&`. A bare `nohup server` on POSIX is still rewritten (it inherits the tool's pipes).
- Log files derive from the first token of the command + timestamp, written to `cfg.logDir` (default `%TMP%\opencode\server-logs` on Windows, `os.tmpdir()/opencode/server-logs` on POSIX).
- WSL1 on this machine (`wsl -d Ubuntu`) is a real POSIX testbed for the `nohup` branch — no node inside WSL, so test the emitted command as a `.sh` file, not via `node`.
- Regression guard: `npm run verify` (`verify/leakregress.mjs`) builds the Windows command for a 4 s child, runs it with a piped parent, and fails if the call takes over 1.5 s. Run it after ANY change to the Windows builder. The full 77-check suite (detection matrix, rewrite shape, real detach, DIED/STALLED/UNHEALTHY/RECOVERED, kill-notes, watchdog end-to-end, config parsing) was run against this build and passed 77/77; the portable subset is committed under `verify/`.

## Timeout enforcement (`src/index.ts`)

The hook ALWAYS overrides `output.args.timeout` (the bash tool's own timeout arg) before the command runs:

- Commands detected + rewritten as server starts → `timeout = detachTimeoutMs` (default **15000**). A working detach returns in milliseconds, so this only bounds a broken start.
- Everything else → `timeout = min(existing, bashTimeoutMs)` (default **10 min**), the hard ceiling. If the caller passed no timeout, the ceiling is imposed.

Honest caveat, measured on 2026-10-23: the timeout did NOT free the call that stalled. A rewritten start outlived its 15 s bound by minutes while the server held the tool's pipe. Treat the timeout as a backstop that may not fire, and the no-inherited-handles primitive as the actual fix. Never rely on the timeout to make a leaking detach safe — that is how the two stalls happened.

## The external watchdog (`src/watchdog.ts` + `src/watchdog-runner.ts`)

The lazy probe (`probeServers`) only runs *inside* a bash call — if the agent goes away or stops issuing commands, a wedged server (alive but silent: a recompile hang, a bound-but-deaf socket, a stray process) can hold its port forever, invisible to the next command. That is the gap the detached watchdog fills.

- On every bash call the hook calls `ensureWatchdog(dir, cfg)`: spawns ONE detached `node` child (`process.execPath`, `dist/watchdog-runner.js`) per log dir with `{detached, stdio:'ignore', windowsHide:true}` + `child.unref()`, so the child can never inherit or pin an agent's tool pipe. Single-instance: a `.watchdog.pid` lock file records the runner's pid; a live runner is reused (stale pids let a later spawn replace a dead runner).
- The runner polls the state dir every `watchdogPollMs` (default **10000**). Any tracked server whose logs have been silent for `watchdogStalledAfterMs` (default **5 min**) is force-killed — `taskkill /PID <pid> /T /F` on Windows to take the whole tree, `SIGKILL` on POSIX. Its `.state.json` + `.pid` are removed and a `<stem>-<ts>.kill.note.json` is written beside them.
- The lazy probe's `readKillNotes(dir)` picks up kill-notes on the next bash call, renders `[server-start-guard] server KILLED by watchdog (pid N, log silence > 5m): <stem>`, then deletes the note (reported exactly once). If the agent never issues another bash call, the kill still happened — the note just waits.
- The runner exits when no `.state.json` files remain (no idle process left behind). It deliberately leaves dead-pid cleanup to the lazy probe so DIED is still announced by the probe, not swallowed.

Decisions locked in:
- Watchdog ignores servers whose logs were NEVER written (`newest === 0`) — still booting, do not kill.
- Watchdog ignores dead pids — that is the lazy probe's DIED job.
- Kill threshold uses log-write staleness (mtime of out/err logs), deliberately NOT HTTP health: the lazy probe owns health; the watchdog only reaps log-silent processes, which is the "stuck for hours" case.
- Config keys (all optional; absent/malformed → defaults): `watchdogEnabled` (bool, default true), `watchdogPollMs` (default 10000), `watchdogStalledAfterMs` (default 5 * 60 * 1000).

## Config

Runtime config at `~/.config/opencode/plugins/server-start-guard/config.json`, re-read on every hook invocation — edits apply without an opencode restart. Keys: `enabled` (bool), `logDir` (string), `bashTimeoutMs` (default 10 min — hard ceiling on every non-rewritten bash call), `detachTimeoutMs` (default 15000 — forced timeout on rewritten calls), `watchdogEnabled` (bool, default true), `watchdogPollMs` (default 10000), `watchdogStalledAfterMs` (default 5 min), `extraPatterns` (string[] of substrings), `healthChecks` (`[{pattern, url}]` of explicit probe URLs — first substring match wins; empty by default), `defaultHealthChecks` (bool, default true — the built-in vite/ng/next/uvicorn etc. port map), `healthTimeoutMs` (default 2000), `healthIntervalMs` (default 15000), `healthGraceMs` (default 30000). Absent/malformed config silently falls back to defaults. If the configured `logDir` can't be created, the rewrite silently falls back to the default `%TMP%\opencode\server-logs` — don't be surprised by logs landing there instead of the custom dir.

## Fixed: the Windows hang (2026-10-23)

The old Windows primitive (`Start-Process` with `-RedirectStandardInput/Output/Error`) leaked the tool's stdout pipe into the detached tree, so the bash call stayed open for as long as the server ran. Two agent turns stalled on it, and the 15 s timeout did not free either one. The launcher now uses `Win32_Process.Create`; verified end to end: call returns in ~0.3 s, server stays up, logs keep growing, `taskkill /T` frees the port.

If a "stuck after starting a server" report appears again, check the emitted command for `Win32_Process` first. A `Start-Process` in it means an old `dist/` is installed.