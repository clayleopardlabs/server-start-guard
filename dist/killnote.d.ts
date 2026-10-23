/**
 * Kill-note primitives, shared by the watchdog (writer) and the status probe
 * (reader). Kept in their own module so neither watchdog.ts nor status.ts need
 * to import each other (no import cycle).
 */
export interface KillNote {
    pid: number;
    command: string;
    display: string;
    stalledMs: number;
    killedAt: string;
}
/** Kill-note path beside a state file. */
export declare function killNotePath(statePath: string): string;
export declare function writeKillNote(statePath: string, note: KillNote): void;
export declare function readKillNote(notePath: string): KillNote | undefined;
