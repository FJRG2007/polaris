/**
 * The messages that are an invitation meant for one person, which a forward
 * would hand to people it was never meant for: a game server's invite for a
 * player, the card that lets somebody onto a server, and the invite to a game
 * played in a call. Each names a seat - a player name, an address, a session -
 * and passing it on passes the seat on.
 *
 * A chat's own invite link is not one of these: it is made to be shared.
 *
 * Pure, so the menu that leaves Forward out and the server that refuses it read
 * the same rule.
 */

import { activityIdIn } from "./activity-card";
import { gameInviteIn, gameServerIdIn } from "./game-server-card";

/** Whether a message with this body is a private invitation, never forwarded. */
export function isPrivateInvitation(body: string): boolean {
    return gameInviteIn(body) !== null || gameServerIdIn(body) !== null || activityIdIn(body) !== null;
}

/** Why a message may never be forwarded; each has its own sentence (`errors.<reason>NotForwarded`). */
export type ForwardBlock = "invitation" | "liveLocation" | "locationRequest" | "notice" | "interactive";

/**
 * Why a message may never be forwarded, or null when nothing about it forbids
 * it. A forward carries a message to people its sender never picked, so what is
 * refused is everything that only means something - or is only safe - where it
 * was sent:
 *
 * - an invitation for one person (above);
 * - a live location: the sender's position as it moves, shared with the people
 *   they chose for as long as they chose, as WhatsApp refuses it;
 * - a request for somebody's location: it is addressed to the people in that
 *   chat, and its buttons answer there;
 * - a line Polaris wrote itself (somebody joined, a call started or ended):
 *   nobody said it, and a call's card leads into that call;
 * - a message with buttons or a form from an app or a bot: those run against
 *   the original in its own chat, so a copy would carry controls that do
 *   nothing, or act on a chat the new readers cannot see.
 *
 * A pin dropped once is a place like any other and stays forwardable, and so
 * does a poll, as in Telegram. Pure, so the menu that leaves Forward out and the
 * server that refuses it read the same rule.
 */
export function forwardBlock(message: {
    body: string;
    kind?: string;
    location?: { mode: string } | null;
    components?: readonly unknown[] | null;
}): ForwardBlock | null {
    if (message.kind === "system" || message.kind === "call") return "notice";
    if (message.location?.mode === "live") return "liveLocation";
    if (message.location?.mode === "request") return "locationRequest";
    if (message.components && message.components.length > 0) return "interactive";
    return isPrivateInvitation(message.body) ? "invitation" : null;
}
