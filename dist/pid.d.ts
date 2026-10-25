/**
 * Shared pid liveness check used by both the in-process probe (status.ts) and
 * the detached watchdog (watchdog.ts). Kept in its own module so those two do
 * not import each other.
 */
export declare function isAlive(pid: number): boolean;
/**
 * Accurate liveness check, for verifying a kill.
 *
 * `process.kill(pid, 0)` is not enough there: on Windows it still reports true
 * for a process that has already terminated but whose handle is open somewhere
 * else (any parent holding the ChildProcess object is enough). tasklist lists
 * only processes that still exist, so a kill can be confirmed instead of
 * guessed. POSIX needs no such workaround.
 */
export declare function isAliveStrict(pid: number): boolean;
