// Windows detach leak regression guard.
//
// The bug this catches: a detached server that inherits the caller's stdout
// pipe keeps the bash tool call open for as long as the server runs. Measured
// on this machine, `Start-Process -RedirectStandard*` held a piped caller for
// 4620 ms on a 4 s child; `Win32_Process.Create` returns in ~250 ms.
//
// Run after ANY change to the Windows builder:  npm run verify
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rewriteJs = path.join(ROOT, "dist", "rewrite.js");
if (!fs.existsSync(rewriteJs)) {
  console.error(`missing ${rewriteJs} - run "npm run build" first`);
  process.exit(2);
}

const { buildWindowsCommand } = await import(pathToFileURL(rewriteJs).href);

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ssg-verify-"));
const pidPath = path.join(DIR, "launcher.pid");

// Grandchild lives ~4 s: a leaking primitive makes the call take ~4 s.
const cmd = buildWindowsCommand(
  'node -e "setTimeout(()=>{},4000)"',
  path.join(DIR, "out.log"),
  path.join(DIR, "err.log"),
  DIR,
  pidPath,
);

const started = Date.now();
const run = spawnSync("pwsh", ["-NoProfile", "-Command", cmd], {
  timeout: 12000,
  encoding: "utf-8",
  stdio: "pipe",
});
const elapsed = Date.now() - started;

const pid = fs.existsSync(pidPath) ? Number(fs.readFileSync(pidPath, "utf-8").trim()) : 0;
if (pid > 0) {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}
fs.rmSync(DIR, { recursive: true, force: true });

const problems = [];
if (run.status !== 0) problems.push(`launcher exited ${run.status}: ${(run.stderr || "").slice(0, 300)}`);
if (elapsed > 1500) problems.push(`call took ${elapsed} ms - the detached child is holding the parent pipe`);
if (pid <= 0) problems.push("no pid file written");

if (problems.length > 0) {
  console.error("FAIL");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`PASS  detached start returned in ${elapsed} ms (pid ${pid}), pipe not held`);
