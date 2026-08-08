/**
 * Who may connect to a game server, and from where.
 *
 * A server is closed until somebody is named. Both images already start with their
 * list enforced and empty, which is a server nobody on earth can join and nothing
 * anywhere saying why - so creating one names its first player instead of leaving
 * the list blank, and the same pair of answers governs every player added later:
 * a username, and the address that username is allowed to arrive from.
 *
 * The username half is the game's own list (Java's whitelist, an operator entry).
 * The address half is not - Minecraft has no concept of a player belonging to an
 * address, so it is held here and enforced on the join, which is the first moment
 * the address exists. That makes it a check after the connection rather than
 * before it: a stolen account gets as far as the login screen and no further.
 * Operators who do not want it turn it off per server from the firewall.
 *
 * Everything in this module is pure so both sides can use it: the browser to
 * validate the form as it is typed, the server to validate what it is sent.
 */

import type { MinecraftEdition } from "@/lib/apps/minecraft/service";

/** A Java username: what Mojang allows, which is what the image resolves. */
export const JAVA_NAME_PATTERN = /^[A-Za-z0-9_]{3,16}$/;

/** An Xbox gamertag, as far as it can be checked without asking Xbox: letters and
 *  digits in single-spaced words, up to Microsoft's limit. */
export const GAMERTAG_PATTERN = /^[A-Za-z0-9]+(?: [A-Za-z0-9]+){0,3}$/;

/** Whether a name is one this edition's server could accept at all. */
export function isPlayerName(edition: MinecraftEdition, name: string): boolean {
    const value = name.trim();
    return edition === "bedrock"
        ? value.length >= 1 && value.length <= 15 && GAMERTAG_PATTERN.test(value)
        : JAVA_NAME_PATTERN.test(value);
}

/**
 * An address rule as the operator writes it: one IPv4 address, a CIDR range, or
 * `any` for a player whose address moves and who accepts that risk.
 */
export function isAddressRule(value: string): boolean {
    const rule = value.trim().toLowerCase();
    if (rule === ANY_ADDRESS) return true;
    const [address, bits] = rule.split("/");
    if (!isIpv4(address ?? "")) return false;
    if (bits === undefined) return true;
    const prefix = Number(bits);
    return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

/** The rule that lets a player in from wherever they are. */
export const ANY_ADDRESS = "any";

function isIpv4(value: string): boolean {
    const parts = value.split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function toLong(address: string): number | null {
    if (!isIpv4(address)) return null;
    return address.split(".").reduce((total, part) => total * 256 + Number(part), 0);
}

/**
 * Whether a connection's address satisfies a rule.
 *
 * An address that cannot be read never matches. That is the safe direction: the
 * consequence is a player being asked to add the address they are on, where the
 * other way round is a rule that silently lets everyone through.
 */
export function addressMatches(rule: string, address: string): boolean {
    const wanted = rule.trim().toLowerCase();
    if (wanted === ANY_ADDRESS) return true;
    const [network, bits] = wanted.split("/");
    const candidate = toLong(address.trim());
    const base = toLong(network ?? "");
    if (candidate === null || base === null) return false;
    const prefix = bits === undefined ? 32 : Number(bits);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
    if (prefix === 0) return true;
    // Shifting by 32 is a no-op in JavaScript, so the full-length mask is written out.
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
    return ((candidate & mask) >>> 0) === ((base & mask) >>> 0);
}

/**
 * What the player list actually stops, said in one place because two screens show
 * it and a protection described differently in two places is one nobody trusts.
 *
 * Worth being blunt about, because the obvious reading of "who can connect" is a
 * network block and it is not one. The port is open to anyone who can route to it:
 * the server answers the status ping, so a stranger sees the name, the description,
 * the icon and the player count, and only finds out they are not welcome when they
 * press Join. What the list refuses is the login, which is the account getting in -
 * not the packet arriving.
 *
 * Closing the port itself is the firewall's job and it is not wired to this list
 * yet; until it is, this is the honest description of the difference.
 */
export const ACCESS_REACH_NOTE =
    "The port stays open to anyone who can reach it, so a stranger can still see this server in their list and read its description. What the list refuses is the login: an unregistered name, or a registered one arriving from somewhere else, does not get in.";

/** One player, and where they are allowed to connect from. */
export interface PlayerAccess {
    readonly username: string;
    readonly address: string;
}

/** Why a connected player is not allowed to be, or null when they are. */
export function accessRefusal(
    player: string,
    address: string | null,
    allowed: readonly PlayerAccess[]
): string | null {
    const entry = allowed.find((item) => item.username.toLowerCase() === player.toLowerCase());
    if (!entry) return "You are not on this server's player list.";
    if (address === null) return null;
    return addressMatches(entry.address, address)
        ? null
        : "Your account is registered to a different network. Ask the server's owner to add this one.";
}

export interface JoinAccess {
    /** Image environment that puts the first player on the game's own list, so the
     *  server is joinable by them the moment it finishes booting. */
    readonly env: Readonly<Record<string, string>>;
    /** What the operator should know about how closed the server actually is. */
    readonly note: string;
}

/**
 * The list a new server starts with, from the player creating it. `player` is
 * assumed validated - the schema does that, and an unchecked name would be written
 * straight into the image's environment.
 *
 * Both variables merge into whatever the container already holds rather than
 * replacing it (the image's `EXISTING_WHITELIST_FILE` / `EXISTING_OPS_FILE`
 * default), so players added later survive a restart.
 */
export function joinAccess(edition: MinecraftEdition, player: string): JoinAccess {
    const name = player.trim();
    if (edition === "bedrock") {
        // Bedrock's allow list is keyed by XUID, a number that does not exist until
        // the player has connected once, so a gamertag cannot fill it. The address
        // rules are the list that actually closes this server.
        return {
            env: { ALLOW_LIST: "false", OPS: name },
            note: `${name} runs the server. Bedrock's own allow list is keyed by a player's XUID, which only exists once they have connected, so the server is closed by the player list here instead.`
        };
    }
    return {
        env: { WHITELIST: name, OPS: name },
        note: `Only ${name} can join, as the server's operator. Add the rest from Players.`
    };
}
