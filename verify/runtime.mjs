/**
 * Runtime resolution guard.
 *
 * The watchdog needs a JavaScript runtime to launch its detached runner. Two
 * mistakes have already shipped here and both were silent:
 *
 *   1. using `process.execPath`, which inside opencode is `opencode.exe` - so
 *      spawning it started a second opencode instead of the runner;
 *   2. trusting PATH, which opencode strips (measured: one entry), so no
 *      runtime was found and the watchdog degraded to an in-process timer that
 *      dies with the agent.
 *
 * This checks the resolver survives a stripped PATH and never returns a path
 * that is not a real JS runtime.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolveRunnerRuntime } from "../dist/watchdog.js";

const savedPath = process.env.PATH;
const savedSsg = process.env.SSG_NODE_PATH;
const savedNpm = process.env.npm_node_execpath;
delete process.env.SSG_NODE_PATH;
delete process.env.npm_node_execpath;

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}

const isJsRuntime = (p) => /(^|[\\/])(node|bun)(\.exe)?$/i.test(p);

// The state opencode actually presents: a single-entry PATH.
process.env.PATH = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin";
const stripped = resolveRunnerRuntime();
check("finds a runtime with a stripped PATH", () => {
  assert.ok(stripped, "no runtime resolved");
  assert.ok(existsSync(stripped), `${stripped} does not exist`);
  assert.ok(isJsRuntime(stripped), `${stripped} is not node or bun`);
  assert.ok(!/opencode/i.test(stripped), `${stripped} is opencode itself`);
});

check("an explicit path wins", () => {
  assert.ok(stripped, "no runtime to compare against");
  assert.equal(resolveRunnerRuntime(stripped), stripped);
});

check("a nonexistent explicit path is ignored", () => {
  const bogus = process.platform === "win32" ? "C:\\nope\\node.exe" : "/nope/node";
  const got = resolveRunnerRuntime(bogus);
  assert.equal(got, stripped, `expected fallback to ${stripped}, got ${got}`);
});

process.env.PATH = savedPath;
if (savedSsg !== undefined) process.env.SSG_NODE_PATH = savedSsg;
if (savedNpm !== undefined) process.env.npm_node_execpath = savedNpm;

console.log(failures === 0 ? "runtime: 3/3 passed" : `runtime: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
