import { execFileSync } from "node:child_process";
/**
 * Shared pid liveness check used by both the in-process probe (status.ts) and
 * the detached watchdog (watchdog.ts). Kept in its own module so those two do
 * not import each other.
 */
export function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
/**
 * Accurate liveness check, for verifying a kill.
 *
 * `process.kill(pid, 0)` is not enough there: on Windows it still reports true
 * for a process that has already terminated but whose handle is open somewhere
 * else (any parent holding the ChildProcess object is enough). tasklist lists
 * only processes that still exist, so a kill can be confirmed instead of
 * guessed. POSIX needs no such workaround.
 */
export function isAliveStrict(pid) {
    if (process.platform !== "win32")
        return isAlive(pid);
    try {
        const out = execFileSync("tasklist", ["/NH", "/FI", `PID eq ${pid}`, "/FO", "CSV"], {
            encoding: "utf-8",
            timeout: 4000,
            windowsHide: true,
            stdio: ["ignore", "pipe", "ignore"],
        });
        return out.includes(`"${pid}"`);
    }
    catch {
        return isAlive(pid);
    }
}
//# sourceMappingURL=pid.js.map