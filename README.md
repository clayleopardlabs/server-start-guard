# Server Start Guard

A simple add-on for opencode. It stops your AI assistant from getting stuck when it starts a server.

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

The server command is rewritten into a detached form with its output redirected to log files, so the `bash` call returns immediately:

- **Windows:** the command is handed to a fresh `pwsh` (encoded, base64 UTF-16LE) which is started through `Win32_Process.Create`. That starts the new process with no inherited handles, so nothing in the new process tree can hold the assistant's output pipe open. The new process sends its own output and errors to the log files and records its pid.
- **macOS / Linux:** the command is single-quote-escaped and run as `nohup sh -c '<command>' </dev/null >out.log 2>err.log &`, and the server writes its own pid to a `.pid` file.

Logs land in `%TMP%\opencode\server-logs` (Windows) or `os.tmpdir()/opencode/server-logs` (POSIX), or a custom `logDir` from the config.

## Status reporting

The guard also watches over servers it detached. Every time the assistant runs a `bash` command, a tiny in-process probe checks the tracked servers. It only announces changes worth knowing:

- **servername DIED**: the server process is gone. Reported once; its tracking files are cleaned up immediately afterwards.
- **servername STALLED**: the server process is still running, but it has not written to its log for 2 minutes (a possible "returned but went quiet" case). A later log write reports "recovered".
- **servername UNHEALTHY**: the server process is running, but it has not returned a single good HTTP response (a real `<500` status) for 2 minutes. A lone slow request, recompile, or late boot does **not** trigger this. Only a *stale last-successful response* does, so a server pausing for a rebuild is never mistaken for a dead one.
- **servername RECOVERED**: a server that was stalled or unhealthy is healthy again.

Healthy servers are silent, so the guard never spams "still running" on every command. A server is only watched from startup until it dies or is explicitly stopped.

### How the health check finds the right port

Health probing is last-successful-response based: the guard tracks *when the last real `<500` answer arrived*, and only escalates to UNHEALTHY once that goes stale (2 minutes). The probe target is chosen in this order:

1. **The port the server printed in its own logs** (authoritative). Dev servers increment their port when the requested one is taken, so a stale instance can hold the guessed port while the real process serves elsewhere. Grabbing the URL the process itself announced sidesteps that entirely.
2. An explicit `healthChecks` rule whose pattern matches the command.
3. A built-in guess for well-known dev servers (vite, Angular, Next, Python/uvicorn/django, and a few more).
4. None of the above: pure pid + log monitoring.

Every probe also covers **both loopback address families** (IPv4 `127.0.0.1` and IPv6 `::1`), so a server that binds only one family is still reachable. A timeout is recorded as a distinct failure kind from a refused connection, but neither one by itself declares a server unhealthy. Only the stale last-successful-response clock does. If nothing answers a guessed port, that is treated as a wrong guess, not a sick server, because a dev server often moves to another port.

## No more stuck agents

Two mechanisms make sure an agent can never wait for hours again:

1. **A hard time limit on every bash command.** The guard always sets the bash tool's own timeout. A command that is rewritten as a server start gets a short bound (default 15 seconds), because a working detached start returns in milliseconds. Every other command gets a ceiling (default 10 minutes). This limit is a backstop, not the fix. A call can outlive its limit when the started program still holds the assistant's pipe. The real fix is that the new process tree holds none of the assistant's pipes.
2. **A separate watchdog process.** The lazy status probe only runs when the agent runs a bash command. If the agent stops issuing commands, a quiet-but-alive server could hold its port forever with nobody looking. To close that gap, the guard starts one detached helper process (outside the agent entirely, with no connection to any tool pipe). It checks the tracking files every 10 seconds, and force-kills any tracked server whose logs say nothing for 5 minutes. Before killing, it asks the server once: a quiet server that still answers HTTP is left alone. It writes a small note next to the removed tracking files, and the next bash command reports "server KILLED by watchdog". It stops itself when no running server is left to watch.

## Configuration

Settings live in `~/.config/opencode/plugins/server-start-guard/config.json` and are read again on every command, so edits apply without restarting opencode:

- `enabled` (bool): turn the guard on or off.
- `logDir` (string): where detached servers write their logs (and the guard its tracking files).
- `bashTimeoutMs` (number, default `600000`): the hard time limit (ms) for every non-rewritten bash command. A command asked to run longer is cut down to this.
- `detachTimeoutMs` (number, default `15000`): the time limit (ms) given to a command that was rewritten into a detached server start. It returns in milliseconds anyway; this bound only protects against a broken rewrite.
- `watchdogEnabled` (bool, default `true`): turn the detached watchdog on or off.
- `watchdogPollMs` (number, default `10000`): how often the watchdog checks the tracking files.
- `watchdogStalledAfterMs` (number, default `300000`): how long a server's logs must stay silent before the watchdog force-kills it.
- `extraPatterns` (string[]): extra substrings; any command containing one is treated as a server start.
- `healthChecks` (array of `{ "pattern": "...", "url": "..." }`): explicit health-check URLs. The first rule whose pattern appears in the command wins, e.g. to probe your custom port:
  ```json
  "healthChecks": [
    { "pattern": "npm run dev", "url": "http://localhost:8080" }
  ]
  ```
- `defaultHealthChecks` (bool, default `true`): off (`false`) disables the built-in port guesses; then only explicit `healthChecks` rules, URLs printed in the server's own logs, and pid/log monitoring apply.
- `healthTimeoutMs` (default `2000`): how long each health request may take before it is recorded as a timeout.
- `healthIntervalMs` (default `15000`): minimum time between health probes of the same server.
- `healthGraceMs` (default `30000`): how long after startup to wait before the first probe, so a slow-starting server isn't flagged.

## How to remove

1. Delete this folder.
2. Remove the line about server start guard from the opencode settings file.
3. Restart opencode.

## A note on Windows

Older versions started the detached server with `Start-Process` and file redirection. That form still inherits the assistant's output pipe, so the `bash` call could stay open for as long as the server ran. The launcher now uses `Win32_Process.Create`, which starts the process with no inherited handles. Tested with a long running server: the call returns in about 0.3 seconds and the server keeps running.