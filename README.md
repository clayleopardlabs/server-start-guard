# Server Start Guard

A simple add-on for opencode that stops your AI assistant from getting stuck when it starts a server.

## What it does

When the assistant starts a long running program like a server, this add-on quietly moves that program to run in the background. The assistant keeps working instead of waiting forever.

## How to install

**Windows**
1. Download this folder onto your computer.
2. Double click the file named `install.bat`.
3. Restart opencode.

**macOS / Linux**
1. Download this folder onto your computer.
2. Run `./install.sh` from the folder (`chmod +x install.sh` first if needed).
3. Restart opencode.

You are done.

## What happens when a server starts

The server command is rewritten into a detached form with all of its input and output redirected to log files, so the `bash` call returns immediately:

- **Windows:** a second `pwsh` is launched with the original command encoded (`-EncodedCommand`, base64 UTF-16LE), with stdout/stderr/stdin redirected to real files and `-PassThru` used to capture the launcher's pid.
- **macOS / Linux:** the command is single-quote-escaped and run as `nohup sh -c '<command>' </dev/null >out.log 2>err.log &`, with the job's pid captured to a `.pid` file.

Logs land in `%TMP%\opencode\server-logs` (Windows) or `os.tmpdir()/opencode/server-logs` (POSIX), or a custom `logDir` from the config.

## Status reporting

The guard also watches over servers it detached. Every time the assistant runs a `bash` command, a tiny in-process probe checks the tracked servers and announces only changes worth knowing:

- **servername DIED** — the server process is gone. Reported once; its tracking files are cleaned up immediately afterwards.
- **servername STALLED** — the server process is still running, but it has not written to its log for 2 minutes (a possible "returned but went quiet" case). A later log write reports "recovered".
- **servername UNHEALTHY** — the server process is running, but it has not returned a single good HTTP response (a real `<500` status) for 2 minutes. A lone slow request, recompile, or late boot does **not** trigger this — only a *stale last-successful response* does, so a server pausing for a rebuild is never mistaken for a dead one.
- **servername RECOVERED** — a server that was stalled or unhealthy is healthy again.

Healthy servers are silent, so the guard never spams "still running" on every command. A server is only watched from startup until it dies or is explicitly stopped.

### How the health check finds the right port

Health probing is last-successful-response based: the guard tracks *when the last real `<500` answer arrived*, and only escalates to UNHEALTHY once that goes stale (2 minutes). The probe target is chosen in this order:

1. **The port the server printed in its own logs** (authoritative). Dev servers increment their port when the requested one is taken, so a stale instance can hold the guessed port while the real process serves elsewhere — grabbing the URL the process itself announced sidesteps that entirely.
2. An explicit `healthChecks` rule whose pattern matches the command.
3. A built-in guess for well-known dev servers (vite, Angular, Next, Python/uvicorn/django, and a few more).
4. None of the above — pure pid + log monitoring.

Every probe also covers **both loopback address families** (IPv4 `127.0.0.1` and IPv6 `::1`), so a server that binds only one family is still reachable. A timeout is recorded as a distinct failure kind from a refused connection, but neither one by itself declares a server unhealthy — only the stale last-successful-response clock does.

## Configuration

Settings live in `~/.config/opencode/plugins/server-start-guard/config.json` and are read again on every command, so edits apply without restarting opencode:

- `enabled` (bool) — turn the guard on or off.
- `logDir` (string) — where detached servers write their logs (and the guard its tracking files).
- `extraPatterns` (string[]) — extra substrings; any command containing one is treated as a server start.
- `healthChecks` (array of `{ "pattern": "...", "url": "..." }`) — explicit health-check URLs. The first rule whose pattern appears in the command wins, e.g. to probe your custom port:
  ```json
  "healthChecks": [
    { "pattern": "npm run dev", "url": "http://localhost:8080" }
  ]
  ```
- `defaultHealthChecks` (bool, default `true`) — off (`false`) disables the built-in port guesses; then only explicit `healthChecks` rules, URLs printed in the server's own logs, and pid/log monitoring apply.
- `healthTimeoutMs` (default `2000`) — how long each health request may take before it is recorded as a timeout.
- `healthIntervalMs` (default `15000`) — minimum time between health probes of the same server.
- `healthGraceMs` (default `30000`) — how long after startup to wait before the first probe, so a slow-starting server isn't flagged.

## How to remove

1. Delete this folder.
2. Remove the line about server start guard from the opencode settings file.
3. Restart opencode.

## One known issue

On Windows, a helper agent can stay stuck after it starts a server, even though the server itself runs fine. This is a problem in opencode on Windows, not in this add-on. The server keeps working while the helper agent is stuck.