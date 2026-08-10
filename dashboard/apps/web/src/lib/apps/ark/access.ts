/**
 * Who is allowed onto an ARK server, and what the rules for saying so are.
 *
 * Two locks, because either one alone has a way of failing open. The join
 * password is what a player types, and it is the only thing standing between the
 * server and the whole internet the moment its port is forwarded - the image
 * ships a default one that is printed in its own README, so a server is never
 * created without a password of its own. The allow list is the other half:
 * `-exclusivejoin` makes the server refuse anyone whose Steam id it was not
 * given, which is the same posture a Minecraft server gets from its whitelist.
 *
 * A player is identified by their Steam id and nothing else. ARK has no username
 * to whitelist - a character can be renamed at will and two people can pick the
 * same name - so the 17-digit number is what a rule can actually be written
 * against, and the label beside it is only there so a human can read the row.
 *
 * Pure on purpose: the create dialog checks a Steam id as it is typed against
 * exactly these rules, and the action re-checks with the same function.
 */

/** A SteamID64: seventeen digits, and every account's starts the same way. */
const STEAM_ID_64 = /^7656119\d{10}$/;

/** Letters and digits only. ARK carries the join password through its own connect
 *  string, where punctuation is at best unreliable, so a password that would be
 *  refused at the door is refused here instead. */
const JOIN_PASSWORD = /^[A-Za-z0-9]{8,32}$/;

/** Ambiguous glyphs left out, so a password can be read off a screen and typed
 *  into a game by somebody who is not looking at both at once. */
const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export const GENERATED_PASSWORD_LENGTH = 16;

export function isSteamId(value: string): boolean {
    return STEAM_ID_64.test(value.trim());
}

export function isJoinPassword(value: string): boolean {
    return JOIN_PASSWORD.test(value);
}

/** What to say when a password is refused, in the terms it was refused on. */
export const JOIN_PASSWORD_HINT = "8 to 32 letters and digits, and nothing else - ARK will not carry the rest";

/**
 * A join password nobody had to invent.
 *
 * `random` is the caller's source of randomness so this can run on either side:
 * the dialog fills the field in from `crypto.getRandomValues` as it opens, and
 * the server can mint one from `randomBytes` without a second implementation
 * that picks from a different alphabet.
 */
export function generateJoinPassword(random: (size: number) => Uint8Array): string {
    const bytes = random(GENERATED_PASSWORD_LENGTH);
    let password = "";
    for (const byte of bytes) password += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
    return password;
}

/** One player the server is meant to let in. */
export interface ArkAllowedPlayer {
    /** Their SteamID64, which is what the server is actually told. */
    readonly steamId: string;
    /** What to call them in the list. A 17-digit number identifies nobody on
     *  sight, and a moderation screen made of them is unusable. */
    readonly label: string;
    readonly addedAt: string;
    /** When the running server was last told about them. Null while it has never
     *  been told - a server that is still downloading 30 GB cannot be, and the
     *  screen has to be able to say the difference. */
    readonly appliedAt: string | null;
}

/** Where the list lives on the install's own settings blob. */
export const ALLOW_LIST_KEY = "arkAllowList";

/**
 * The allow list as the install recorded it.
 *
 * Anything that is not a well-formed entry is dropped rather than repaired: this
 * is a settings blob a future version may write differently, and a row that
 * cannot be read is one the server must not be told about.
 */
export function readAllowList(config: Record<string, unknown>): ArkAllowedPlayer[] {
    const raw = config[ALLOW_LIST_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const row = entry as Record<string, unknown>;
        if (typeof row.steamId !== "string" || !isSteamId(row.steamId)) return [];
        return [
            {
                steamId: row.steamId,
                label: typeof row.label === "string" ? row.label : row.steamId,
                addedAt: typeof row.addedAt === "string" ? row.addedAt : new Date(0).toISOString(),
                appliedAt: typeof row.appliedAt === "string" ? row.appliedAt : null
            }
        ];
    });
}

/** The list with one player on it, added or left as they were. Adding somebody
 *  who is already there must not reset what the server has been told about them. */
export function withPlayer(
    list: readonly ArkAllowedPlayer[],
    player: { steamId: string; label: string },
    now: string
): ArkAllowedPlayer[] {
    if (list.some((entry) => entry.steamId === player.steamId)) {
        return list.map((entry) =>
            entry.steamId === player.steamId ? { ...entry, label: player.label || entry.label } : entry
        );
    }
    return [...list, { steamId: player.steamId, label: player.label || player.steamId, addedAt: now, appliedAt: null }];
}

/** The list without one player. */
export function withoutPlayer(list: readonly ArkAllowedPlayer[], steamId: string): ArkAllowedPlayer[] {
    return list.filter((entry) => entry.steamId !== steamId);
}

/** The players the running server has not been told about yet. */
export function pendingPlayers(list: readonly ArkAllowedPlayer[]): ArkAllowedPlayer[] {
    return list.filter((entry) => entry.appliedAt === null);
}

/**
 * The launch options a server runs with, given whether it is meant to be closed.
 *
 * One string holds every flag the image passes on the command line, so this
 * rewrites that string rather than replacing it: an operator who added
 * `-PreventHibernation` keeps it when the door is opened or shut.
 */
export function withExclusiveJoin(options: string, closed: boolean): string {
    const flags = options
        .split(/\s+/)
        .map((flag) => flag.trim())
        .filter((flag) => flag.length > 0 && flag.toLowerCase() !== "-exclusivejoin");
    if (closed) flags.push("-exclusivejoin");
    return flags.join(" ");
}

/** Whether a server's launch options close it to everyone but the allow list. */
export function isExclusiveJoin(options: string | undefined): boolean {
    return (options ?? "").split(/\s+/).some((flag) => flag.trim().toLowerCase() === "-exclusivejoin");
}
