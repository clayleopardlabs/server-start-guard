/**
 * Shared pid liveness check used by both the in-process probe (status.ts) and
 * the detached watchdog (watchdog.ts). Kept in its own module so those two do
 * not import each other (watchdog imports kill-note readers from status; a
 * status->watchdog import would be a cycle).
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
//# sourceMappingURL=pid.js.map