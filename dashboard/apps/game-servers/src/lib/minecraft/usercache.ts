/**
 * The server's usercache: who has joined, under which UUID, and when last.
 * Pure, so anything that needs a name's UUID reads it the same way.
 */

/** The map from a name to the uuid the world files it under. Written by the server
 *  whenever somebody joins, so it holds everyone who ever has. */
interface CacheEntry {
    readonly name?: unknown;
    readonly uuid?: unknown;
    /** A month after the player last joined under this uuid: "2026-10-27 18:04:12 +0000". */
    readonly expiresOn?: unknown;
}

/** Every uuid this name is filed under. Usually one; two where the server
 *  switched between online and offline mode, which files the same player under a
 *  different uuid from then on - and both files are that player's time. */
export function uuidsFor(usercache: string, name: string): string[] {
    const wanted = name.trim().toLowerCase();
    return [...namesByUuid(usercache)]
        .filter(([, cached]) => cached.trim().toLowerCase() === wanted)
        .map(([uuid]) => uuid);
}

/** The usercache's entries; none when it cannot be read. */
function cacheEntries(usercache: string): CacheEntry[] {
    try {
        const parsed: unknown = JSON.parse(usercache);
        return Array.isArray(parsed) ? (parsed as CacheEntry[]) : [];
    } catch {
        return [];
    }
}

/** The usercache as uuid to name, lowercased uuids; empty when it cannot be read. */
export function namesByUuid(usercache: string): Map<string, string> {
    const names = new Map<string, string>();
    for (const entry of cacheEntries(usercache)) {
        if (typeof entry?.name === "string" && typeof entry?.uuid === "string") {
            names.set(entry.uuid.toLowerCase(), entry.name);
        }
    }
    return names;
}

const EXPIRES_ON = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/;

/** When each uuid was last joined under, as the usercache's expiry of it, in
 *  milliseconds; a uuid whose expiry cannot be read is left out. */
export function seenByUuid(usercache: string): Map<string, number> {
    const seen = new Map<string, number>();
    for (const entry of cacheEntries(usercache)) {
        if (typeof entry?.uuid !== "string" || typeof entry?.expiresOn !== "string") continue;
        const parts = EXPIRES_ON.exec(entry.expiresOn.trim());
        const at = parts ? Date.parse(`${parts[1]}T${parts[2]}${parts[3]}:${parts[4]}`) : NaN;
        if (Number.isFinite(at)) seen.set(entry.uuid.toLowerCase(), at);
    }
    return seen;
}

/** The UUID this name last joined under, or null for a name never seen join. */
export function latestUuid(usercache: string, name: string): string | null {
    const seen = seenByUuid(usercache);
    return (
        uuidsFor(usercache, name)
            .map((uuid) => uuid.toLowerCase())
            .sort((a, b) => (seen.get(b) ?? 0) - (seen.get(a) ?? 0))[0] ?? null
    );
}
