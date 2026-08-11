/**
 * What a timeout is, in ARK's own words.
 *
 * The two commands the shared timeout service needs, bound to this game. Keyed by
 * Steam id rather than by name, like every other verb ARK has: a character can be
 * renamed at will, and a ban that lifts itself has to find the same person a week
 * later.
 *
 * ARK's ban carries no reason - `BanPlayer` takes an id and nothing else - so the
 * reason is said to them first, in chat, and then they are thrown out. A reason
 * typed into the form and silently dropped would be worse than not asking for
 * one. It is best effort: somebody who is not on the server cannot be told
 * anything, and that must not stop the ban.
 *
 * Everything about when a timeout ends and who is still serving one lives in
 * `lib/apps/player-timeout-service`, where Minecraft reads it too.
 */

import type { PlayerTimeout } from "@/lib/apps/player-timeout";
import { banArkPlayer, messageArkPlayer, unbanArkPlayer } from "./service";
import {
    grantTimeout,
    liftTimeout as liftPlayerTimeout,
    sweepTimeouts as sweepPlayerTimeouts,
    type TimeoutCommands
} from "@/lib/apps/player-timeout-service";

const ARK: TimeoutCommands = {
    ban: async (ownerId, installedAppId, steamId, reason) => {
        await messageArkPlayer(ownerId, installedAppId, steamId, reason).catch(() => undefined);
        await banArkPlayer(ownerId, installedAppId, steamId);
    },
    pardon: (ownerId, installedAppId, steamId) => unbanArkPlayer(ownerId, installedAppId, steamId)
};

export function timeoutArkPlayer(
    ownerId: string,
    installedAppId: string,
    steamId: string,
    minutes: number,
    reason?: string
): Promise<PlayerTimeout> {
    return grantTimeout(ARK, ownerId, installedAppId, steamId, minutes, reason);
}

export function liftArkTimeout(ownerId: string, installedAppId: string, steamId: string): Promise<void> {
    return liftPlayerTimeout(ARK, ownerId, installedAppId, steamId);
}

export function sweepArkTimeouts(ownerId: string, installedAppId: string): Promise<number> {
    return sweepPlayerTimeouts(ARK, ownerId, installedAppId);
}
