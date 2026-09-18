/**
 * A server somebody already built, kept so they can build that one again.
 *
 * The blueprints and the maps are Polaris's: they say what a bed wars server *is*,
 * they are the same for everybody, and they are compiled into the app. That is the
 * right answer right up until somebody has spent an evening getting theirs exactly
 * so - the view distance, the plugin list, the four settings nobody remembers
 * finding - and then wants a second one like it. Until now the answer was to do
 * the evening again.
 *
 * So a template is not a second kind of blueprint. It is a note about how one
 * person likes theirs: which blueprint and map it came from, and **only the
 * settings that ended up differing** from what that blueprint would have given it.
 * Storing the whole environment instead would freeze last year's defaults into
 * every server built from it, so a template made before an image update would
 * quietly undo the update.
 *
 * Pure: what a template is and how one is worked out from a built server. The
 * reading and writing is `game-templates-service.ts`.
 */

/** What a saved server carries, as a screen reads it back. */
export interface ServerTemplateView {
    readonly id: string;
    readonly name: string;
    readonly summary: string;
    readonly game: string;
    readonly edition: string;
    readonly blueprintId: string;
    readonly mapId: string;
    readonly version: string;
    readonly concurrentPlayers: number;
    readonly crossplay: boolean;
    /** How many settings it carries, which is the only honest one-line summary of
     *  "how different is this from just picking the blueprint". */
    readonly settings: number;
    readonly createdAt: string;
}

/**
 * Settings that a container is told and Polaris must never copy.
 *
 * Everything here identifies one particular server rather than describing the kind
 * of server it is. A port copied into a template is two servers fighting over it;
 * a level name copied is a second server pointed at the first one's world; a
 * password copied is a secret in a list somebody shares. None of it is what anybody
 * means by "make another one like this".
 */
const NEVER_COPIED = new Set([
    "SERVER_PORT",
    "RCON_PORT",
    "QUERY_PORT",
    "RCON_PASSWORD",
    "SERVER_NAME",
    "LEVEL",
    "LEVEL_NAME",
    "WORLD",
    "SEED",
    "MOTD",
    "OPS",
    "WHITELIST",
    "ALLOW_LIST",
    "EXISTING_WHITELIST_FILE",
    "SERVER_PASSWORD",
    "ADMIN_PASSWORD",
    "SESSION_NAME"
]);

/** And the prefixes of the same, for the settings that come in families. */
const NEVER_COPIED_PREFIXES = ["POLARIS_", "RCON_", "GEYSER_PORT"];

export function copyable(key: string): boolean {
    const name = key.trim().toUpperCase();
    if (name.length === 0 || NEVER_COPIED.has(name)) return false;
    return !NEVER_COPIED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * What is worth remembering about a built server: what it has that a fresh one
 * built the same way would not.
 *
 * The comparison is the point. A template that carried every variable would carry
 * whatever the image happened to default to on the day it was saved, and building
 * from it a year later would silently put those defaults back - a template that
 * undoes an upgrade. Only the differences travel.
 */
export function templateSettings(
    built: ReadonlyMap<string, string>,
    fresh: ReadonlyMap<string, string>
): Record<string, string> {
    const settings: Record<string, string> = {};
    for (const [key, value] of built) {
        if (!copyable(key)) continue;
        const trimmed = value.trim();
        // A blank is not a setting somebody chose; it is the absence of one, and
        // carrying it would write emptiness over a new server's own default.
        if (trimmed.length === 0) continue;
        if ((fresh.get(key) ?? "").trim() === trimmed) continue;
        settings[key] = value;
    }
    return settings;
}

/** The settings a template holds, back out of the column they are stored in. */
export function readTemplateSettings(raw: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const settings: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === "string" && copyable(key)) settings[key] = value;
    }
    return settings;
}

/** A name somebody can pick out of a list a month later. */
export function isTemplateName(value: string): boolean {
    const name = value.trim();
    return name.length > 0 && name.length <= 60;
}
