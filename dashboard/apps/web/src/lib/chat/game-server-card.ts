/**
 * The card a person gets in a direct message when they are let onto a game
 * server: its name and game, the address to paste, Join where the game takes a
 * link, and how to join for somebody who has never done it.
 *
 * Built like the activity card: a `system` message whose body is only the
 * server's mark, so nothing about the server is stored on the message. What the
 * card says is read again for every reader, and only for one who may still
 * reach the server - an address is never handed to somebody who lost access.
 *
 * Pure, so every game's guide and link can be checked without a database.
 */

import { z } from "zod";

const MARK_PREFIX = "polaris-game-server:";

const serverIdSchema = z.string().uuid();

/** The body of the card's message. */
export function gameServerMark(installedAppId: string): string {
    return `${MARK_PREFIX}${installedAppId}`;
}

/** The server a message body is the card of, or null for any other body. */
export function gameServerIdIn(body: string): string | null {
    if (!body.startsWith(MARK_PREFIX)) return null;
    const id = serverIdSchema.safeParse(body.slice(MARK_PREFIX.length));
    return id.success ? id.data : null;
}

/** Which "how to join" the card shows. */
export type JoinGuide = "minecraftJava" | "minecraftBedrock" | "ark" | "fivem" | "hytale" | "other";

export function joinGuideFor(game: string | null, edition: string | null): JoinGuide {
    if (game === "minecraft") return edition === "bedrock" ? "minecraftBedrock" : "minecraftJava";
    if (game === "ark" || game === "fivem" || game === "hytale") return game;
    return "other";
}

/** The host and the port of an address, for the games that ask for them in two
 *  fields. A bare host keeps a null port. */
export function splitAddress(address: string): { host: string; port: string | null } {
    const trimmed = address.trim();
    const match = /^(.+):(\d{1,5})$/.exec(trimmed);
    return match?.[1] && match[2] ? { host: match[1], port: match[2] } : { host: trimmed, port: null };
}

/** A link that opens the game straight on the server, for the games that
 *  register one, or null for the ones where the address is pasted by hand. */
export function joinLinkFor(game: string | null, address: string | null): string | null {
    if (!address) return null;
    // FiveM's client registers `fivem://connect/<host:port>`.
    if (game === "fivem") return `fivem://connect/${encodeURI(address.trim())}`;
    return null;
}

/** What the card shows a reader. */
export type GameServerCardView =
    | { readonly state: "denied" }
    | {
          readonly state: "ready";
          readonly id: string;
          readonly name: string;
          readonly game: string | null;
          readonly address: string | null;
          readonly release: string | null;
          readonly running: boolean;
          readonly guide: JoinGuide;
          readonly joinLink: string | null;
          /** The server's own page in Polaris. */
          readonly href: string;
      };

/** Where the server's page is. */
export function gameServerHref(installedAppId: string): string {
    return `/game-servers/${installedAppId}`;
}

/** The card a reader who may reach the server sees, from what the game app read. */
export function cardView(facts: {
    readonly id: string;
    readonly name: string;
    readonly game: string | null;
    readonly edition: string | null;
    readonly address: string | null;
    readonly release: string | null;
    readonly running: boolean;
}): GameServerCardView {
    return {
        state: "ready",
        id: facts.id,
        name: facts.name,
        game: facts.game,
        address: facts.address,
        release: facts.release,
        running: facts.running,
        guide: joinGuideFor(facts.game, facts.edition),
        joinLink: joinLinkFor(facts.game, facts.address),
        href: gameServerHref(facts.id)
    };
}
