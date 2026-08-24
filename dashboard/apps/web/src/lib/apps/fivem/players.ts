/**
 * Who is on a FiveM server, and what a player actually is on one.
 *
 * The server publishes three small JSON documents on its own port and nothing has
 * to be enabled for them: who is connected, how full it is, and what it is
 * running. That is where every reading on the players screen comes from, because
 * it is the only one that does not cost a console round trip - a page watching six
 * servers would otherwise be six commands every few seconds.
 *
 * A player here has no single name that means anything. The name is whatever they
 * set in their own settings and two people can pick the same one, so nothing is
 * ever keyed on it: every rule Polaris writes is written against an identifier,
 * which the game hands over and the player cannot choose. There are several kinds
 * and they are not interchangeable - a licence is the account, a Steam id is the
 * shop it was bought from, an address is where they happen to be sitting - so each
 * is kept as it came and named by its kind.
 *
 * Pure and client-safe: the players table renders these types in the browser.
 */

/** The kinds of identifier a FiveM client presents, in the order they are worth
 *  trusting. The licence is the account itself and is always there; the rest are
 *  whatever that account happens to be linked to. */
export const IDENTIFIER_KINDS = ["license", "steam", "discord", "fivem", "live", "xbl", "ip"] as const;

export type IdentifierKind = (typeof IDENTIFIER_KINDS)[number];

/** What each kind is called on a screen, since `xbl` and `live` mean nothing on
 *  sight and "license" is not a word anybody would guess at. */
export const IDENTIFIER_LABEL: Readonly<Record<IdentifierKind, string>> = {
    license: "Cfx account",
    steam: "Steam",
    discord: "Discord",
    fivem: "FiveM forum",
    live: "Xbox Live",
    xbl: "Xbox",
    ip: "Address"
};

/** One person on the server right now. */
export interface FivemPlayer {
    /** The slot they are in. Small, reused the moment they leave, and the only
     *  thing the console's own commands take - so it is what a kick is addressed
     *  to and never what anything is remembered by. */
    readonly id: number;
    readonly name: string;
    /** Round trip in milliseconds, as the server measures it. */
    readonly ping: number;
    /** Everything the client presented, `kind:value` as it came. */
    readonly identifiers: readonly string[];
    /** Where they are connected from, when the server is willing to say. A server
     *  with `sv_endpointprivacy` on reports this as `127.0.0.1` for everyone. */
    readonly endpoint: string | null;
}

/** How full the server is and what it says it is running. */
export interface FivemDynamic {
    readonly clients: number;
    readonly maxClients: number;
    readonly hostname: string;
    readonly gametype: string;
    readonly mapname: string;
}

/** What the server says about itself: its resources, and the variables it
 *  advertises to the browser. */
export interface FivemInfo {
    /** Every resource that is started right now, as the server names them. */
    readonly resources: readonly string[];
    /** The `sets` variables, which is where a server's tags and locale live. */
    readonly vars: Readonly<Record<string, string>>;
    /** The build it is running, e.g. `FXServer-master v1.0.0.7290`. */
    readonly server: string;
}

/** Who is on, from `/players.json`. Anything that is not a well-formed row is
 *  dropped rather than repaired: a row Polaris cannot read is a player it must
 *  not offer a moderator any buttons for. */
export function parsePlayers(raw: unknown): FivemPlayer[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const row = entry as Record<string, unknown>;
        const id = Number(row.id);
        if (!Number.isInteger(id)) return [];
        const identifiers = Array.isArray(row.identifiers)
            ? row.identifiers.filter((value): value is string => typeof value === "string")
            : [];
        return [
            {
                id,
                name: typeof row.name === "string" ? row.name : `Player ${id}`,
                ping: Number.isFinite(Number(row.ping)) ? Number(row.ping) : 0,
                identifiers,
                endpoint: typeof row.endpoint === "string" && row.endpoint.length > 0 ? row.endpoint : null
            }
        ];
    });
}

/** How full it is, from `/dynamic.json`. */
export function parseDynamic(raw: unknown): FivemDynamic | null {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    return {
        clients: Number.isFinite(Number(row.clients)) ? Number(row.clients) : 0,
        maxClients: Number.isFinite(Number(row.sv_maxclients)) ? Number(row.sv_maxclients) : 0,
        hostname: typeof row.hostname === "string" ? row.hostname : "",
        gametype: typeof row.gametype === "string" ? row.gametype : "",
        mapname: typeof row.mapname === "string" ? row.mapname : ""
    };
}

/** What it is running, from `/info.json`. */
export function parseInfo(raw: unknown): FivemInfo | null {
    if (typeof raw !== "object" || raw === null) return null;
    const row = raw as Record<string, unknown>;
    const vars: Record<string, string> = {};
    if (typeof row.vars === "object" && row.vars !== null) {
        for (const [key, value] of Object.entries(row.vars as Record<string, unknown>)) {
            if (typeof value === "string") vars[key] = value;
        }
    }
    return {
        resources: Array.isArray(row.resources)
            ? row.resources.filter((value): value is string => typeof value === "string")
            : [],
        vars,
        server: typeof row.server === "string" ? row.server : ""
    };
}

/** One kind of identifier off a player, or null when they presented none of it. */
export function identifierOf(player: { identifiers: readonly string[] }, kind: IdentifierKind): string | null {
    const prefix = `${kind}:`;
    const found = player.identifiers.find((entry) => entry.toLowerCase().startsWith(prefix));
    return found ? found.slice(prefix.length) : null;
}

/**
 * The one identifier a rule about this player should be written against.
 *
 * The licence, because it is the Cfx account itself: it is present on every
 * client, it survives them signing out of Steam, and it is not something they can
 * change to get back in. The rest are a fallback for the rare client that
 * presented no licence at all, in the order they are worth trusting - and the
 * address is deliberately last, because a ban on one is a ban on whoever is
 * sitting behind it tomorrow.
 */
export function primaryIdentifier(player: { identifiers: readonly string[] }): string | null {
    for (const kind of IDENTIFIER_KINDS) {
        const value = identifierOf(player, kind);
        if (value) return `${kind}:${value}`;
    }
    return null;
}

/** Whether a string is shaped like an identifier at all, for a field somebody
 *  types one into. The kind has to be one the game actually presents; the value
 *  is whatever that kind's issuer made it. */
export function isIdentifier(value: string): boolean {
    const trimmed = value.trim();
    const at = trimmed.indexOf(":");
    if (at <= 0 || at === trimmed.length - 1) return false;
    if (/[\s"]/.test(trimmed)) return false;
    return (IDENTIFIER_KINDS as readonly string[]).includes(trimmed.slice(0, at).toLowerCase());
}

/**
 * An identifier as it is stored and compared: lowercased, whole.
 *
 * Every kind the game presents is hex, digits or an address, so nothing is lost -
 * and the resource at the door lowercases both sides before comparing, which is
 * the reason this does too. A screen that matched case-sensitively while the door
 * did not would show somebody as "not on the list" and let them straight in.
 */
export function normalizeIdentifier(value: string): string {
    return value.trim().toLowerCase();
}

/** Which kind an identifier is, for the label beside it. */
export function kindOf(identifier: string): IdentifierKind | null {
    const kind = identifier.slice(0, Math.max(0, identifier.indexOf(":"))).toLowerCase();
    return (IDENTIFIER_KINDS as readonly string[]).includes(kind) ? (kind as IdentifierKind) : null;
}

/** Whether this player presented one particular identifier, whatever else they
 *  presented alongside it. */
export function playerHasIdentifier(player: { identifiers: readonly string[] }, identifier: string): boolean {
    const wanted = normalizeIdentifier(identifier);
    return player.identifiers.some((entry) => normalizeIdentifier(entry) === wanted);
}

/** The address a player is connected from, without the port the endpoint carries.
 *  Null on a server that hides them, which is the default a Polaris server is
 *  created with. */
export function addressOf(player: FivemPlayer): string | null {
    const direct = identifierOf(player, "ip");
    if (direct) return direct;
    if (!player.endpoint) return null;
    const at = player.endpoint.lastIndexOf(":");
    return at === -1 ? player.endpoint : player.endpoint.slice(0, at);
}
