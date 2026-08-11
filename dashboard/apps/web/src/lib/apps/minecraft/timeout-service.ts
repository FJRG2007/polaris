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
import type { PlayerTimeout } from "@/lib/apps/player-timeout";
import {
    grantTimeout,
    liftTimeout as liftPlayerTimeout,
    sweepTimeouts as sweepPlayerTimeouts,
    type TimeoutCommands
} from "@/lib/apps/player-timeout-service";

export { readPlayerTimeouts } from "@/lib/apps/player-timeout-service";

const MINECRAFT: TimeoutCommands = {
    ban: (ownerId, installedAppId, player, reason) => runServerCommand(ownerId, installedAppId, ["ban", player, reason]),
    pardon: (ownerId, installedAppId, player) => runServerCommand(ownerId, installedAppId, ["pardon", player])
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
