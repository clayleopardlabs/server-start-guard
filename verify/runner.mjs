/**
 * Watchdog runner guard.
 *
 * The runner has two timers on the same interval: the scan, and an idle check
 * that exits once no live server is tracked. A scan is asynchronous - after a
 * kill it waits up to 2 s for the pid to disappear before it removes the
 * sidecar and writes the KILLED note. The idle check used to fire inside that
 * window, see the freshly killed pid, and call process.exit(0) mid-scan, so
 * the note was never written and the sidecar survived for the lazy probe to
 * report as a plain DIED. The kill looked like a crash.
 *
 * This reproduces the race with the shortest interval the runner allows, so a
 * regression fails here instead of quietly losing the note in production.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const runner = path.resolve("dist/watchdog-runner.js");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssg-runner-"));
const stem = path.join(dir, "srv");
const outLog = `${stem}.out.log`;
const errLog = `${stem}.err.log`;
const statePath = `${stem}.state.json`;
const pidPath = `${stem}.pid`;
const lockPath = path.join(dir, ".watchdog.pid");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function killPid(pid) {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    // already gone
  }
}

let failures = 0;
let server;
let runnerProc;

try {
  // A server that never writes a log line again, so only the runner can end it.
  server = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  server.unref();

  fs.writeFileSync(outLog, "boot\n");
  fs.writeFileSync(errLog, "");
  fs.writeFileSync(pidPath, String(server.pid));
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      command: "node server.js",
      workdir: process.cwd(),
      startedAt: new Date().toISOString(),
      outLog,
      errLog,
    }),
  );
  fs.writeFileSync(
    path.join(dir, ".watchdog.json"),
    JSON.stringify({
      pollMs: 1000,
      stalledAfterMs: 1500,
      healthTimeoutMs: 1000,
      lockPath,
    }),
  );

  runnerProc = spawn(process.execPath, [runner, dir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  runnerProc.unref();

  // Long enough for: first scan, stall threshold, kill, and the 2 s verification.
  await sleep(7000);

  const notes = fs.readdirSync(dir).filter((f) => f.endsWith(".kill.note.json"));
  const checks = [
    ["the wedged server is gone", () => assert.ok(!alive(server.pid))],
    ["the sidecar is removed", () => assert.ok(!fs.existsSync(statePath))],
    ["the pid file is removed", () => assert.ok(!fs.existsSync(pidPath))],
    ["a KILLED note is written", () => assert.ok(notes.length === 1)],
    ["the runner stops once nothing is left to watch", () => assert.ok(!runnerProc.pid || !alive(runnerProc.pid))],
  ];
  for (const [name, fn] of checks) {
    try {
      fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures++;
      console.log(`FAIL  ${name}: ${err.message}`);
    }
  }
} finally {
  if (server?.pid) killPid(server.pid);
  if (runnerProc?.pid) killPid(runnerProc.pid);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "runner: 5/5 passed" : `runner: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
