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

import { runServerCommand } from "./service";
import { repairRosterIdentity } from "./player-access";
import type { PlayerTimeout } from "@/lib/apps/player-timeout";
import {
    grantTimeout,
    liftTimeout as liftPlayerTimeout,
    sweepTimeouts as sweepPlayerTimeouts,
    type TimeoutCommands
} from "@/lib/apps/player-timeout-service";

export { readPlayerTimeouts } from "@/lib/apps/player-timeout-service";

/**
 * Say it, then make sure the server will still mean it tomorrow.
 *
 * Both commands write `banned-players.json`, which the server keys by the
 * identity it resolved for the name. On a server with authentication off that is
 * not the identity an arriving player computes, so the entry names the banned
 * player and matches nobody: the ban holds while the server is up, because the
 * kick already happened, and is silently gone the next time it starts. Correcting
 * the file behind the command is what makes it a ban rather than a kick.
 */
async function banAndKeep(ownerId: string, installedAppId: string, argv: readonly string[]): Promise<string> {
    const said = await runServerCommand(ownerId, installedAppId, argv);
    await repairRosterIdentity(ownerId, installedAppId, "bans").catch(() => false);
    return said;
}

const MINECRAFT: TimeoutCommands = {
    ban: (ownerId, installedAppId, player, reason) => banAndKeep(ownerId, installedAppId, ["ban", player, reason]),
    pardon: (ownerId, installedAppId, player) => banAndKeep(ownerId, installedAppId, ["pardon", player])
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
