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

/**
 * The invite a person gets from whoever added them as a player: an ordinary
 * message from that person, not a line Polaris wrote, whose body is a Markdown
 * link. Every screen that shows a message as text (previews, toasts, quotes,
 * pins) reads the link's words, so the mark itself never shows; the
 * conversation draws the card from the target.
 */
const INVITE_SCHEME = "polaris-game-invite:";

/** A player name as the games here spell one: a Java name, a Bedrock gamertag
 *  (letters and digits with single spaces), a Hytale name or a SteamID64.
 *  Nothing that could close the link or reach a path. */
const PLAYER_PATTERN = /^[A-Za-z0-9_](?:[A-Za-z0-9_.-]| (?! ))*$/;
const PLAYER_MAX = 32;

/** The whole body: escaped words in brackets, then the target. */
const INVITE_BODY = /^\[(?:[^\\\]]|\\.)+\]\(polaris-game-invite:([0-9a-fA-F-]{36})\/([^()\s]+)\)$/;

const inviteSchema = z.object({
    installedAppId: serverIdSchema,
    player: z
        .string()
        .min(1)
        .max(PLAYER_MAX)
        .regex(PLAYER_PATTERN)
        .refine((value) => !value.endsWith(" "))
});

export interface GameInvite {
    readonly installedAppId: string;
    readonly player: string;
}

/** The characters that would end a link's words early or open new Markdown. */
function escapeLabel(text: string): string {
    return text
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[\\[\]()*_`~<>#|!]/g, (found) => `\\${found}`);
}

/**
 * The body of an invite message.
 *
 * @param label - What a screen that shows the message as text reads, in the
 *   invited person's language. Defaults to the player name.
 * @throws When the id or the player name is not one this could have made.
 */
export function gameInviteMark(installedAppId: string, player: string, label = player): string {
    const invite = inviteSchema.parse({ installedAppId, player });
    const words = escapeLabel(label) || escapeLabel(invite.player);
    return `[${words}](${INVITE_SCHEME}${invite.installedAppId}/${encodeURIComponent(invite.player)})`;
}

/** The server and player a message body invites to, or null for any other body. */
export function gameInviteIn(body: string): GameInvite | null {
    const match = INVITE_BODY.exec(body.trim());
    if (!match?.[1] || !match[2]) return null;
    let player: string;
    try {
        player = decodeURIComponent(match[2]);
    } catch {
        return null;
    }
    const invite = inviteSchema.safeParse({ installedAppId: match[1], player });
    return invite.success ? invite.data : null;
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

/** Where an invited player may connect from, as the game app reads it now. */
export type GamePlayerJoinFrom =
    | { readonly kind: "signIns" }
    | { readonly kind: "anywhere" }
    | { readonly kind: "addresses"; readonly addresses: readonly string[] }
    | { readonly kind: "ask" };

/** What an invite card shows a reader: the server's card, who to join as, from
 *  where, and whether this reader may open the server's page. */
export type GameInviteCardView =
    | { readonly state: "denied" }
    | (Extract<GameServerCardView, { state: "ready" }> & {
          readonly player: string;
          readonly joinFrom: GamePlayerJoinFrom | null;
          readonly canOpen: boolean;
      });

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
