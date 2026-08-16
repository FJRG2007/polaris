/**
 * Reading a survivor out of an ARK player file.
 *
 * ARK has no command that says what level somebody is on. Its RCON answers who is
 * connected and nothing else about them, so the only place the number exists is
 * the `.arkprofile` the server writes per player - one file per Steam id, in the
 * save folder, holding that survivor's name, level and stats.
 *
 * The file is Unreal's own property serialisation, and the part that matters is
 * simple and stable: a property is two length-prefixed, null-terminated strings -
 * the name and the type - then a 32-bit size, a 32-bit index, then the value, all
 * little-endian. So rather than parse the whole document, this finds the two
 * properties worth showing and reads their values in place. Anything it cannot
 * make sense of comes back null, because a survivor drawn at the wrong level is
 * worse than one drawn without a level at all.
 *
 * Pure and byte-level on purpose: it can be tested exactly, and it has to be -
 * this is the one thing here that reads a binary format nobody at Polaris owns.
 */

/** What a survivor's file says about them. Every field is optional: an old file,
 *  a half-written one and a file from a version that renamed something all have
 *  to read as "not known" rather than as a wrong number. */
export interface ArkProfile {
    /** The survivor's in-game name, which is not their Steam name. */
    readonly characterName: string | null;
    /** The level they are on, counting the one they start at. */
    readonly level: number | null;
    /**
     * The number the game knows them by, as a string.
     *
     * ARK's admin commands take this rather than the Steam id, and there is no
     * reliable command that turns one into the other - `GetPlayerIDForSteamID` has
     * been broken for years and answers with something else. The file is where it
     * actually lives, so everything on the panel that reaches a particular player -
     * giving them an item, killing them - comes back to this one read.
     *
     * A string, not a number: it is 64 bits wide and only ever printed or passed
     * on, so putting it through a float would be a rounding waiting to happen.
     */
    readonly dataId: string | null;
}

/** How far a level can plausibly be from the file before the read is treated as a
 *  misparse. ARK's own ceiling moves with the DLC and the server's own settings, so
 *  this is only a sanity bound on nonsense. */
const MAX_LEVEL = 1000;

const LEVEL_PROPERTY = "CharacterStatusComponent_ExtraCharacterLevel";
const NAME_PROPERTY = "PlayerCharacterName";
const DATA_ID_PROPERTY = "PlayerDataID";

/**
 * One length-prefixed, null-terminated string, and where the next byte is.
 *
 * A negative length is Unreal's way of saying the text is UTF-16; ARK writes
 * property names as plain bytes but a survivor's own name can be anything they
 * typed, so both are read.
 */
function readString(bytes: Buffer, at: number): { value: string; next: number } | null {
    if (at < 0 || at + 4 > bytes.length) return null;
    const length = bytes.readInt32LE(at);
    if (length === 0) return { value: "", next: at + 4 };
    if (length > 0) {
        const end = at + 4 + length;
        if (end > bytes.length) return null;
        // The last byte is the terminator, and is not part of the text.
        return { value: bytes.toString("latin1", at + 4, end - 1), next: end };
    }
    const end = at + 4 + Math.abs(length) * 2;
    if (end > bytes.length) return null;
    return { value: bytes.toString("utf16le", at + 4, end - 2), next: end };
}

/**
 * Where the value of one named property starts, given the type it must be.
 *
 * The name is searched for as bytes and then proved rather than trusted, twice
 * over. The four bytes in front of it have to be its own length, and the string
 * after it has to be the type this property is declared as - because a player can
 * call their survivor anything, including the name of a property, and a name is
 * stored in exactly the same encoding as one. Both checks together are what makes
 * scanning safe on a file this is not parsing in full; a candidate that fails
 * either is stepped over rather than returned.
 */
function findProperty(bytes: Buffer, name: string, type: string): { at: number; size: number } | null {
    const needle = Buffer.from(`${name}\0`, "latin1");
    for (let found = bytes.indexOf(needle); found !== -1; found = bytes.indexOf(needle, found + 1)) {
        const start = found - 4;
        if (start < 0) continue;
        if (bytes.readInt32LE(start) !== needle.length) continue;
        const declared = readString(bytes, found + needle.length);
        if (!declared || declared.value !== type || declared.next + 8 > bytes.length) continue;
        return { at: declared.next + 8, size: bytes.readInt32LE(declared.next) };
    }
    return null;
}

/**
 * The level this survivor is on, or null.
 *
 * The file records how many levels they have gained rather than the level itself,
 * so the one they were born at is added back - a survivor who has never levelled
 * has no property at all, and is level 1.
 */
export function readProfileLevel(bytes: Buffer): number | null {
    const found = findProperty(bytes, LEVEL_PROPERTY, "UInt16Property");
    if (!found || found.size !== 2) return null;
    if (found.at + 2 > bytes.length) return null;
    const level = bytes.readUInt16LE(found.at) + 1;
    return level >= 1 && level <= MAX_LEVEL ? level : null;
}

/** What the survivor called themselves, or null when the file does not say. */
export function readProfileName(bytes: Buffer): string | null {
    const found = findProperty(bytes, NAME_PROPERTY, "StrProperty");
    if (!found) return null;
    const value = readString(bytes, found.at);
    const name = value?.value.trim() ?? "";
    return name.length > 0 && name.length <= 64 ? name : null;
}

/**
 * The id the game knows this survivor by, or null.
 *
 * Eight bytes, unsigned, little-endian like everything else in the file. Read as a
 * BigInt and handed on as digits: nothing here does arithmetic on it, and the
 * value is wider than a JavaScript number can hold exactly.
 */
export function readProfileDataId(bytes: Buffer): string | null {
    const found = findProperty(bytes, DATA_ID_PROPERTY, "UInt64Property");
    if (!found || found.size !== 8) return null;
    if (found.at + 8 > bytes.length) return null;
    const value = bytes.readBigUInt64LE(found.at);
    // Zero is what an unwritten field reads as, and it is not a player.
    return value > 0n ? value.toString() : null;
}

export function parseArkProfile(bytes: Buffer): ArkProfile {
    return {
        characterName: readProfileName(bytes),
        level: readProfileLevel(bytes),
        dataId: readProfileDataId(bytes)
    };
}

/**
 * Several survivors out of one read.
 *
 * The server hands them over as a header naming the player and a line of base64
 * under it, because one shell for twenty players is one SSH handshake rather than
 * twenty. Everything else in that output is skipped rather than parsed: a warning
 * from `find`, a shell notice, and the line at the end that says where the files
 * were - which is the shape the read pays attention to and this deliberately does
 * not.
 *
 * A file that cannot be read is a player with no level, never a screen that fails
 * to draw.
 */
export function parseProfileDump(output: string): Record<string, ArkProfile> {
    const found: Record<string, ArkProfile> = {};
    const lines = output.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const header = /^== (\d{17})$/.exec(lines[index] ?? "");
        if (!header?.[1]) continue;
        const encoded = (lines[index + 1] ?? "").trim();
        index += 1;
        if (!/^[A-Za-z0-9+/=]+$/.test(encoded)) continue;
        try {
            found[header[1]] = parseArkProfile(Buffer.from(encoded, "base64"));
        } catch {
            // Unreadable, which is a survivor nobody can say anything about.
        }
    }
    return found;
}

/** The Steam id a profile file is named after: `76561198…​.arkprofile`. Null for
 *  anything else in the folder, which is how the tribe files and the world itself
 *  are skipped without a second listing. */
export function steamIdOfProfileFile(path: string): string | null {
    const name = path.split(/[\\/]/).pop() ?? "";
    const match = /^(\d{17})\.arkprofile$/.exec(name);
    return match?.[1] ?? null;
}
