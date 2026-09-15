/**
 * What a timeout is, in Minecraft's own words.
 *
 * The two commands the shared timeout service needs, bound to this game: `ban`
 * takes the reason and shows it on the disconnect screen, `pardon` takes it back.
 * Everything about when a timeout ends and who is still serving one lives in
 * `lib/apps/player-timeout-service`, where ARK reads it too.
 *
 * Java only, because the ban it is built on is Java only - Bedrock has no ban
 * command at all.
 */

import { withServerContainer } from "./service";
import { applyOnContainer } from "./player-access";
import type { PlayerTimeout } from "@/lib/apps/player-timeout";
import {
    grantTimeout,
    liftTimeout as liftPlayerTimeout,
    sweepTimeouts as sweepPlayerTimeouts,
    type TimeoutCommands
} from "@/lib/apps/player-timeout-service";

export { readPlayerTimeouts } from "@/lib/apps/player-timeout-service";

/**
 * Say it, and leave the server still meaning it tomorrow.
 *
 * Both verbs write `banned-players.json`, which the server keys by the identity
 * it resolved for the name. On a server with authentication off that is not the
 * identity an arriving player computes, and the two fail in opposite directions:
 * a ban holds only while the server is up, because the kick already happened, and
 * is silently gone the next time it starts; a pardon goes looking for an entry
 * under an identity the corrected file no longer holds, finds nothing, and says
 * so in words that read like success - a timeout that cannot be lifted, which is
 * a permanent ban with a countdown drawn next to it.
 *
 * Which is why neither is spelled out here. `applyOnContainer` is the one place
 * that knows what each verb has to do on such a server, shared with the
 * moderation screen and with the queue, so this cannot drift away from them. One
 * connection covers the command and the file behind it.
 */
function onServer(ownerId: string, installedAppId: string, verb: string, player: string, argv: string[]) {
    return withServerContainer(ownerId, installedAppId, (server) =>
        applyOnContainer(server, verb, player, argv)
    );
}

const MINECRAFT: TimeoutCommands = {
    ban: (ownerId, installedAppId, player, reason) =>
        onServer(ownerId, installedAppId, "ban", player, ["ban", player, reason]),
    pardon: (ownerId, installedAppId, player) => onServer(ownerId, installedAppId, "pardon", player, ["pardon", player])
};

export function timeoutPlayer(
    ownerId: string,
    installedAppId: string,
    player: string,
    minutes: number,
    reason?: string
): Promise<PlayerTimeout> {
    return grantTimeout(MINECRAFT, ownerId, installedAppId, player, minutes, reason);
}

export function liftTimeout(ownerId: string, installedAppId: string, player: string): Promise<void> {
    return liftPlayerTimeout(MINECRAFT, ownerId, installedAppId, player);
}

export function sweepTimeouts(ownerId: string, installedAppId: string): Promise<number> {
    return sweepPlayerTimeouts(MINECRAFT, ownerId, installedAppId);
}
