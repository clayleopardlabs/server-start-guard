import * as fs from "node:fs";

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
export function killNotePath(statePath: string): string {
  return statePath.replace(/\.state\.json$/i, "") + ".kill.note.json";
}

export function writeKillNote(statePath: string, note: KillNote): void {
  try {
    fs.writeFileSync(killNotePath(statePath), JSON.stringify(note), "utf-8");
  } catch {
    // probe simply will not see a kill-note; the state itself is gone
  }
}

export function readKillNote(notePath: string): KillNote | undefined {
  try {
    return JSON.parse(fs.readFileSync(notePath, "utf-8")) as KillNote;
  } catch {
    return undefined;
  }
}