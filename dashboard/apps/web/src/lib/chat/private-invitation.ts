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
