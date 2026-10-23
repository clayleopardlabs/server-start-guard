import * as fs from "node:fs";
/** Kill-note path beside a state file. */
export function killNotePath(statePath) {
    return statePath.replace(/\.state\.json$/i, "") + ".kill.note.json";
}
export function writeKillNote(statePath, note) {
    try {
        fs.writeFileSync(killNotePath(statePath), JSON.stringify(note), "utf-8");
    }
    catch {
        // probe simply will not see a kill-note; the state itself is gone
    }
}
export function readKillNote(notePath) {
    try {
        return JSON.parse(fs.readFileSync(notePath, "utf-8"));
    }
    catch {
        return undefined;
    }
}
//# sourceMappingURL=killnote.js.map