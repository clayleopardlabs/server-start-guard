import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { isAlive } from "./pid.js";
import { writeKillNote } from "./killnote.js";
function readOptions() {
    try {
        return JSON.parse(process.argv[2] ?? "{}");
    }
    catch {
        process.exit(1);
    }
}
function releaseLock(opts) {
    try {
        fs.unlinkSync(opts.lockPath);
    }
    catch {
        // already gone — fine
    }
}
/** Force-kill a process tree. taskkill /T on Windows, SIGKILL elsewhere. */
function killTree(pid) {
    if (pid <= 0)
        return;
    if (process.platform === "win32") {
        try {
            execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
                stdio: "ignore",
                windowsHide: true,
            });
        }
        catch {
            // taskkill exits non-zero when the pid is already gone — acceptable
        }
        return;
    }
    try {
        process.kill(pid, "SIGKILL");
    }
    catch {
        // already gone — acceptable
    }
}
function newestWriteAcross(sidecar) {
    let newest = 0;
    for (const log of [sidecar.outLog, sidecar.errLog]) {
        try {
            const t = fs.statSync(log).mtimeMs;
            if (t > newest)
                newest = t;
        }
        catch {
            // absent log
        }
    }
    return newest;
}
function scanOnce(opts) {
    let files;
    try {
        files = fs.readdirSync(opts.dir);
    }
    catch {
        return;
    }
    const staleThreshold = opts.stalledAfterMs;
    const now = Date.now();
    for (const f of files) {
        if (!f.toLowerCase().endsWith(".state.json"))
            continue;
        const statePath = path.join(opts.dir, f);
        const base = statePath.replace(/\.state\.json$/i, "");
        const pidPath = base + ".pid";
        let pid = 0;
        try {
            pid = Number((fs.readFileSync(pidPath, "utf-8").trim().match(/\d+/) || [])[0]) || 0;
        }
        catch {
            // pid file not written yet — a very fresh detach; skip
            continue;
        }
        if (!isAlive(pid)) {
            // dead already; the lazy probe will clean up on next bash call, and the
            // runner must not touch it (leaves the DIED announcement to the probe)
            continue;
        }
        let command = "";
        let outLog = "";
        let errLog = "";
        try {
            const sc = JSON.parse(fs.readFileSync(statePath, "utf-8"));
            command = typeof sc.command === "string" ? sc.command : "";
            outLog = typeof sc.outLog === "string" ? sc.outLog : "";
            errLog = typeof sc.errLog === "string" ? sc.errLog : "";
        }
        catch {
            // skip unreadable sidecar
            continue;
        }
        const newest = newestWriteAcross({ outLog, errLog });
        if (newest === 0) {
            // no log ever written — still booting; do not kill yet
            continue;
        }
        if (now - newest >= staleThreshold) {
            killTree(pid);
            try {
                fs.unlinkSync(statePath);
                fs.unlinkSync(pidPath);
            }
            catch {
                // already gone — fine
            }
            writeKillNote(statePath, {
                pid,
                command,
                display: base,
                stalledMs: now - newest,
                killedAt: new Date().toISOString(),
            });
        }
    }
}
function main() {
    const opts = readOptions();
    // Acquire the lock: if another runner holds it (alive), exit quietly so we
    // never double-kill or duplicate. The spawner wrote the pid optimistically;
    // verify it is actually us or a live predecessor.
    try {
        const lockPid = Number((fs.readFileSync(opts.lockPath, "utf-8").trim().match(/\d+/) || [])[0]);
        if (lockPid > 0 && lockPid !== process.pid && isAlive(lockPid)) {
            process.exit(0);
        }
        fs.writeFileSync(opts.lockPath, String(process.pid), "utf-8");
    }
    catch {
        // lock write failed — run anyway (single-instance is best-effort)
    }
    const timer = setInterval(() => scanOnce(opts), Math.max(opts.pollMs, 1000));
    const finish = () => {
        clearInterval(timer);
        releaseLock(opts);
        process.exit(0);
    };
    process.on("SIGINT", finish);
    process.on("SIGTERM", finish);
    process.on("exit", () => releaseLock(opts));
    // Stop once nothing is tracked, so no idle process is left behind.
    const idleTimer = setInterval(() => {
        try {
            const any = fs
                .readdirSync(opts.dir)
                .some((f) => f.toLowerCase().endsWith(".state.json"));
            if (!any)
                finish();
        }
        catch {
            finish();
        }
    }, Math.max(opts.pollMs, 1000));
    // first pass so a dead pid file gets a kill prompt to expire lazily
    setTimeout(() => scanOnce(opts), 500);
}
main();
//# sourceMappingURL=watchdog-runner.js.map