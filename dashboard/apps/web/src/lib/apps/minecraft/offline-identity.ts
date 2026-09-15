/**
 * Who a Minecraft server thinks a player is when nobody authenticated them.
 *
 * A server with `online-mode=false` never asks Mojang anything. It invents each
 * player's identity from their name alone - a version 3 UUID over the bytes of
 * `OfflinePlayer:<name>` - and that invented identity is what the login is keyed
 * by. The roster files are keyed by UUID, not by name.
 *
 * Which is where this goes wrong, silently and completely. `whitelist add Alice`
 * makes the server resolve "Alice" the way it always does - through its user cache
 * and, failing that, Mojang's profile service - so the entry it writes carries
 * Mojang's version 4 UUID for that account. Then Alice connects, the server
 * computes the version 3 one because authentication is off, finds no entry under
 * it, and refuses her with "You are not white-listed on this server". Both halves
 * are behaving exactly as documented, the file plainly lists her, and there is
 * nothing anywhere saying why she cannot get in.
 *
 * So on a server in offline mode Polaris does not ask the game to add anybody. It
 * computes the identity the game itself would compute, writes the file, and tells
 * the server to read it again. Everything here is pure so that can be tested
 * without a container: the same name always yields the same UUID, on any machine,
 * with no server involved.
 *
 * Names are hashed exactly as typed. The game is case-sensitive about this -
 * "Alice" and "alice" are two different players to it - so nothing here
 * normalizes case into the hash, and matching an existing entry is the only place
 * case is ignored, because that is a file somebody else may have written. An
 * entry matched that way is rewritten under the name that was asked for, both
 * halves of it: the identity is the hash of the name beside it, so leaving one
 * and replacing the other is how a working entry becomes one nobody matches.
 */

import { z } from "zod";
import { createHash } from "node:crypto";

/** What the game hashes to invent an identity. Mojang's own constant. */
const OFFLINE_PREFIX = "OfflinePlayer:";

/** How the game writes these files: pretty-printed, two spaces. */
const INDENT = 2;

/**
 * The UUID a server computes for a name when authentication is off.
 *
 * Java's `UUID.nameUUIDFromBytes` is an MD5 digest with two bytes rewritten: the
 * version nibble set to 3, and the top bits of byte 8 set to the RFC 4122
 * variant. Version is the whole point here - Mojang's UUIDs are version 4, so the
 * two can never collide, and a file holding the wrong one is a file the login
 * will never match.
 */
export function offlineUuid(name: string): string {
    const digest = createHash("md5").update(`${OFFLINE_PREFIX}${name}`, "utf8").digest();
    digest.writeUInt8((digest.readUInt8(6) & 0x0f) | 0x30, 6);
    digest.writeUInt8((digest.readUInt8(8) & 0x3f) | 0x80, 8);
    const hex = digest.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The shape of an invented identity: version 3, and the RFC 4122 variant. */
const OFFLINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Whether a UUID is one of the invented ones rather than one Mojang issued. */
export function isOfflineUuid(uuid: string): boolean {
    return OFFLINE_UUID.test(uuid.trim());
}

/**
 * One row of `whitelist.json` or `ops.json`.
 *
 * Passthrough deliberately: an operator entry carries a level and a player-limit
 * flag that this module has no opinion about, and rewriting the file must not be
 * how somebody quietly loses their permission level.
 */
const entrySchema = z
    .object({ uuid: z.string().trim().default(""), name: z.string().trim().min(1).max(32) })
    .passthrough();

const fileSchema = z.array(entrySchema);

type RosterEntry = z.infer<typeof entrySchema>;

/**
 * The entries in a roster file, or null when the text is not one.
 *
 * Blank is an empty roster - a server that has never started has no list, and
 * neither has one nobody has added anybody to. Anything else that will not parse
 * is a file that could not be read rather than a file with nothing in it, and the
 * two are a whole whitelist apart: these files are rewritten by the game itself
 * while it runs, so a read that landed between its own writes comes back as
 * truncated JSON, and treating that as an empty list would hand back a file
 * holding only the names Polaris was adding.
 */
function parseRoster(content: string): RosterEntry[] | null {
    if (content.trim().length === 0) return [];
    try {
        const parsed = fileSchema.safeParse(JSON.parse(content));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Whether this text is a roster file at all, which is what says a write built
 *  from it would replace the list rather than update it. */
export function isReadableRoster(content: string): boolean {
    return parseRoster(content) !== null;
}

function serialize(entries: readonly RosterEntry[]): string {
    return `${JSON.stringify(entries, null, INDENT)}\n`;
}

function sameName(one: string, other: string): boolean {
    return one.trim().toLowerCase() === other.trim().toLowerCase();
}

/**
 * The file with these names on it, each under the identity this server will
 * actually compute, or null when it already says exactly that.
 *
 * Returning null rather than an identical string is what keeps this off the disk
 * of a server whose list has not changed: these files are rewritten by the game
 * itself while it runs, and writing one back for no reason is a chance to land
 * between its own writes.
 *
 * An entry already there is corrected in place rather than duplicated, keeping
 * whatever else it carried. That is the repair for a list that was built by the
 * command this replaces: the name is present, the UUID beside it is Mojang's, and
 * the player it names cannot get in.
 */
export function withOfflineNames(content: string, names: readonly string[]): string | null {
    const entries = parseRoster(content);
    if (entries === null) return null;
    let changed = false;
    for (const name of names) {
        const wanted = name.trim();
        if (wanted.length === 0) continue;
        const uuid = offlineUuid(wanted);
        const found = entries.findIndex((entry) => sameName(entry.name, wanted));
        if (found === -1) {
            entries.push({ uuid, name: wanted });
            changed = true;
            continue;
        }
        const entry = entries[found];
        if (!entry || (entry.uuid === uuid && entry.name === wanted)) continue;
        // Both, never one: the identity is a hash of the name, so an entry
        // carrying somebody else's spelling beside this hash is an entry the
        // login looks up and does not find.
        entries[found] = { ...entry, uuid, name: wanted };
        changed = true;
    }
    return changed ? serialize(entries) : null;
}

/** The file without that name, or null when it was not on it. Every entry under
 *  the name goes, because a list built by the command this replaces can hold the
 *  same player twice - once under each kind of UUID. */
export function withoutName(content: string, name: string): string | null {
    const entries = parseRoster(content);
    if (entries === null) return null;
    const left = entries.filter((entry) => !sameName(entry.name, name));
    return left.length === entries.length ? null : serialize(left);
}

/**
 * The file with every UUID it holds corrected, or null when they are all right.
 *
 * This is the repair pass for a file Polaris did not write: a server whose list
 * was built before this existed holds Mojang UUIDs for every name on it, and one
 * that was half-repaired holds the same player twice. Both are fixed by rewriting
 * from the names, which are the only part of those files that was ever true.
 *
 * Duplicates collapse onto the first entry, which is the one carrying whatever
 * else was set - an operator's level lives on the row somebody actually opped.
 */
export function withOfflineIdentities(content: string): string | null {
    const entries = parseRoster(content);
    if (entries === null) return null;
    const kept: RosterEntry[] = [];
    let changed = false;
    for (const entry of entries) {
        const uuid = offlineUuid(entry.name.trim());
        const seen = kept.findIndex((held) => sameName(held.name, entry.name));
        if (seen !== -1) {
            changed = true;
            continue;
        }
        if (entry.uuid === uuid) {
            kept.push(entry);
            continue;
        }
        kept.push({ ...entry, uuid });
        changed = true;
    }
    return changed ? serialize(kept) : null;
}

/** The names on a roster file. Used to tell what a write would actually change
 *  before making it, and to say what a repair touched. */
export function rosterNames(content: string): string[] {
    return parseRoster(content)?.map((entry) => entry.name) ?? [];
}
