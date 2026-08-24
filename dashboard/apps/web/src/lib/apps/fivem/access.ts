/**
 * Who is allowed onto a FiveM server, who runs it, and who is kept out.
 *
 * FiveM gives a server owner exactly one of those three natively. `add_principal`
 * makes somebody an administrator, and that is written into `server.cfg` where
 * the game reads it. There is no whitelist and no ban list at all - the console
 * can throw somebody off, and they are back thirty seconds later. Every server
 * that has either one has it because a resource was installed to provide it,
 * which is what txAdmin does and what Polaris does here: the lists live on the
 * install, and a small resource Polaris writes into the server enforces them at
 * the door.
 *
 * A player is identified by an identifier and never by a name. See `players.ts`
 * for why: the name is theirs to choose and two people can choose the same one.
 *
 * Pure on purpose. The screens check an identifier as it is typed against exactly
 * these rules, the actions re-check with the same functions, and the file handed
 * to the server is rendered from the same list the screen drew.
 */

import { isIdentifier, normalizeIdentifier } from "@/lib/apps/fivem/players";

/** Where each list lives on the install's own settings blob. */
export const ALLOW_LIST_KEY = "fivemAllowList";
export const BAN_LIST_KEY = "fivemBans";
export const ADMIN_LIST_KEY = "fivemAdmins";
/** Whether only the players on the allow list may join. */
export const EXCLUSIVE_JOIN_KEY = "fivemExclusiveJoin";

/** One player the server is meant to let in. */
export interface FivemAllowedPlayer {
    /** `license:...`, `steam:...` - what the client presents and cannot change. */
    readonly identifier: string;
    /** What to call them in the list. An identifier names nobody on sight. */
    readonly label: string;
    readonly addedAt: string;
    /** When the running server was last handed the list they are on. Null while
     *  it has never been - a server that is still starting cannot be told, and
     *  the screen has to be able to show the difference. */
    readonly appliedAt: string | null;
}

/** One player who is kept out, and until when. */
export interface FivemBan {
    readonly identifier: string;
    readonly label: string;
    /** What they are shown on the connecting screen. */
    readonly reason: string;
    readonly at: string;
    /** When it lifts by itself. Null is a ban that does not. */
    readonly until: string | null;
}

/** One person who may run commands on the server. */
export interface FivemAdmin {
    readonly identifier: string;
    readonly label: string;
    readonly addedAt: string;
}

/** What the whole of the server's access looks like, as one reading. */
export interface FivemAccess {
    readonly allowList: readonly FivemAllowedPlayer[];
    readonly bans: readonly FivemBan[];
    readonly admins: readonly FivemAdmin[];
    /** Whether the allow list is a door or only a note - off, anybody may join. */
    readonly exclusiveJoin: boolean;
}

/** Anything that is not a well-formed row is dropped rather than repaired: this
 *  is a settings blob a later version may write differently, and a row that
 *  cannot be read is one the server must not be told about. */
export function readAllowList(config: Record<string, unknown>): FivemAllowedPlayer[] {
    return rows(config[ALLOW_LIST_KEY]).flatMap((row) => {
        const identifier = identifierOfRow(row);
        if (!identifier) return [];
        return [
            {
                identifier,
                label: text(row.label) || identifier,
                addedAt: text(row.addedAt) || new Date(0).toISOString(),
                appliedAt: text(row.appliedAt) || null
            }
        ];
    });
}

export function readBans(config: Record<string, unknown>): FivemBan[] {
    return rows(config[BAN_LIST_KEY]).flatMap((row) => {
        const identifier = identifierOfRow(row);
        if (!identifier) return [];
        return [
            {
                identifier,
                label: text(row.label) || identifier,
                reason: text(row.reason),
                at: text(row.at) || new Date(0).toISOString(),
                until: text(row.until) || null
            }
        ];
    });
}

export function readAdmins(config: Record<string, unknown>): FivemAdmin[] {
    return rows(config[ADMIN_LIST_KEY]).flatMap((row) => {
        const identifier = identifierOfRow(row);
        if (!identifier) return [];
        return [{ identifier, label: text(row.label) || identifier, addedAt: text(row.addedAt) || new Date(0).toISOString() }];
    });
}

/** Whether the server is meant to refuse anybody who is not on the allow list.
 *  On unless somebody deliberately opened it, which is how a server is created. */
export function readExclusiveJoin(config: Record<string, unknown>): boolean {
    return config[EXCLUSIVE_JOIN_KEY] !== false;
}

function rows(raw: unknown): Record<string, unknown>[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null);
}

function text(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function identifierOfRow(row: Record<string, unknown>): string | null {
    const raw = text(row.identifier);
    return isIdentifier(raw) ? normalizeIdentifier(raw) : null;
}

/** The list with one player on it, added or left as they were. Adding somebody
 *  who is already there must not reset what the server has been told about them. */
export function withAllowed(
    list: readonly FivemAllowedPlayer[],
    player: { identifier: string; label: string },
    now: string
): FivemAllowedPlayer[] {
    const identifier = normalizeIdentifier(player.identifier);
    if (list.some((entry) => entry.identifier === identifier)) {
        return list.map((entry) =>
            entry.identifier === identifier ? { ...entry, label: player.label || entry.label } : entry
        );
    }
    return [...list, { identifier, label: player.label || identifier, addedAt: now, appliedAt: null }];
}

export function withoutAllowed(list: readonly FivemAllowedPlayer[], identifier: string): FivemAllowedPlayer[] {
    const wanted = normalizeIdentifier(identifier);
    return list.filter((entry) => entry.identifier !== wanted);
}

/** The players the running server has not been handed yet. */
export function pendingAllowed(list: readonly FivemAllowedPlayer[]): FivemAllowedPlayer[] {
    return list.filter((entry) => entry.appliedAt === null);
}

/** The list with one ban on it. A second ban on somebody already banned replaces
 *  the first: a moderator banning again is restating the ban, not stacking one. */
export function withBan(
    list: readonly FivemBan[],
    ban: { identifier: string; label: string; reason: string; until?: string | null },
    now: string
): FivemBan[] {
    const identifier = normalizeIdentifier(ban.identifier);
    const row: FivemBan = {
        identifier,
        label: ban.label || identifier,
        reason: ban.reason,
        at: now,
        until: ban.until ?? null
    };
    return [...list.filter((entry) => entry.identifier !== identifier), row];
}

export function withoutBan(list: readonly FivemBan[], identifier: string): FivemBan[] {
    const wanted = normalizeIdentifier(identifier);
    return list.filter((entry) => entry.identifier !== wanted);
}

/** The bans that are still in force at this moment. A timeout that has run out is
 *  no longer a ban, and the list the server is handed must not still carry it. */
export function activeBans(list: readonly FivemBan[], now: Date = new Date()): FivemBan[] {
    return list.filter((entry) => entry.until === null || Date.parse(entry.until) > now.getTime());
}

/** The bans that have run out, for the sweep that takes them off the list. */
export function expiredBans(list: readonly FivemBan[], now: Date = new Date()): FivemBan[] {
    return list.filter((entry) => entry.until !== null && Date.parse(entry.until) <= now.getTime());
}

export function withAdmin(
    list: readonly FivemAdmin[],
    admin: { identifier: string; label: string },
    now: string
): FivemAdmin[] {
    const identifier = normalizeIdentifier(admin.identifier);
    if (list.some((entry) => entry.identifier === identifier)) {
        return list.map((entry) => (entry.identifier === identifier ? { ...entry, label: admin.label || entry.label } : entry));
    }
    return [...list, { identifier, label: admin.label || identifier, addedAt: now }];
}

export function withoutAdmin(list: readonly FivemAdmin[], identifier: string): FivemAdmin[] {
    const wanted = normalizeIdentifier(identifier);
    return list.filter((entry) => entry.identifier !== wanted);
}

/** The name of the block in `server.cfg` that holds the administrators, so the
 *  writer and the reader cannot disagree about which lines are Polaris'. */
export const ADMIN_BLOCK = "Polaris administrators";

/**
 * The administrators as `server.cfg` lines.
 *
 * The group is granted every command and then denied `quit`, which is the shape
 * the game's own documentation uses and the one worth keeping: an administrator
 * who can stop the server from in game is one who can take it down by accident,
 * and stopping it is a button on this page anyway.
 *
 * An empty list still writes the two `add_ace` lines. The group existing with
 * nobody in it is the honest state, and rebuilding it from nothing the moment
 * somebody is added is one more thing that can go wrong at the worst time.
 */
export function adminCfgLines(admins: readonly FivemAdmin[]): string[] {
    return [
        "add_ace group.admin command allow",
        "add_ace group.admin command.quit deny",
        ...admins.map((admin) => `add_principal identifier.${admin.identifier} group.admin`)
    ];
}

/**
 * What opens the server's own console.
 *
 * Not a password anybody types in a game - it is what a tool authenticates with -
 * so it is long, and the alphabet leaves out the glyphs that are read wrongly off
 * a screen, because the one time somebody types this by hand is the time they are
 * copying it into something else.
 */
const CONSOLE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export const CONSOLE_PASSWORD_LENGTH = 24;

const CONSOLE_PASSWORD = /^[A-Za-z0-9]{12,64}$/;

export function isConsolePassword(value: string): boolean {
    return CONSOLE_PASSWORD.test(value);
}

/** What to say when one is refused, in the terms it was refused on. */
export const CONSOLE_PASSWORD_HINT = "12 to 64 letters and digits, and nothing else";

/**
 * A console password nobody had to invent.
 *
 * `random` is the caller's source so this runs on either side: the dialog fills
 * the field in from `crypto.getRandomValues`, and the create flow mints one from
 * `randomBytes` without a second implementation picking from another alphabet.
 */
export function generateConsolePassword(random: (size: number) => Uint8Array): string {
    const bytes = random(CONSOLE_PASSWORD_LENGTH);
    let password = "";
    for (const byte of bytes) password += CONSOLE_ALPHABET[byte % CONSOLE_ALPHABET.length];
    return password;
}

/** What a ban says on the connecting screen when nobody wrote a reason. */
export const DEFAULT_BAN_REASON = "You are banned from this server.";

/** How long a reason may be. It is shown on a screen the player cannot scroll. */
export const MAX_BAN_REASON = 200;

/**
 * Whether a reason is one that survives the trip.
 *
 * One line, and no double quote. It reaches the server through the game console,
 * whose tokenizer has no escape inside a quoted run - so a quote is not something
 * that can be carried, and a message that silently lost half of itself is worse
 * than one refused while somebody was still typing it.
 */
export function isBanReason(value: string): boolean {
    return value.length <= MAX_BAN_REASON && !/[\r\n"]/.test(value);
}

/** What to say when one is refused, in the terms it was refused on. */
export const REASON_HINT = "One line, and no double quotes - the game console cannot carry them.";
