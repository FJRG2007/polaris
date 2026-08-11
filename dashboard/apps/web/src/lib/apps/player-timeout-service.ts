/**
 * Granting, lifting and sweeping the timeouts.
 *
 * Split from `player-timeout.ts` because everything here reaches the server - the
 * game's own ban command and the install's config row - and the players tables
 * that read a timeout run in the browser.
 *
 * The two commands are the only thing a game brings: everything else - writing
 * the note, replacing the one already on that player, and lifting whatever has
 * run out - is the same work whichever game it is, and was worth exactly one
 * copy. A game supplies `ban` and `pardon` and gets the rest.
 *
 * Sweeping is deliberately not left to the cron alone: an instance with no cron
 * configured would hand out timeouts that never end, so the players screen sweeps
 * whenever it is read, exactly as scheduled deletions run lazily when a connection
 * is browsed.
 */

import { prisma } from "@polaris/db";
import { patchInstallConfig, readInstallConfig } from "@/lib/apps/install-config";
import { readTimeouts, TIMEOUTS_KEY, type PlayerTimeout } from "@/lib/apps/player-timeout";

/** What a game has to be able to do for a timeout to mean anything on it. */
export interface TimeoutCommands {
    /** Exclude them now. Throwing is how a game says it could not, which stops the
     *  note being written for a ban that never happened. */
    readonly ban: (ownerId: string, installedAppId: string, player: string, reason: string) => Promise<unknown>;
    /** Let them back in. */
    readonly pardon: (ownerId: string, installedAppId: string, player: string) => Promise<unknown>;
}

/**
 * Ban a player until a moment, and write down when that is.
 *
 * The ban goes first: if the server refuses it there is nothing to lift later,
 * and a note of a ban that was never applied would have the screen reporting
 * somebody as excluded who is still playing.
 */
export async function grantTimeout(
    game: TimeoutCommands,
    ownerId: string,
    installedAppId: string,
    player: string,
    minutes: number,
    reason?: string
): Promise<PlayerTimeout> {
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    await game.ban(
        ownerId,
        installedAppId,
        player,
        reason && reason.length > 0 ? reason : `Timed out for ${minutes} minutes`
    );
    const entry = { player, until };
    const kept = (await readPlayerTimeouts(installedAppId)).filter(
        (held) => held.player.toLowerCase() !== player.toLowerCase()
    );
    await patchInstallConfig(installedAppId, { [TIMEOUTS_KEY]: [...kept, entry] });
    return entry;
}

/** Lift one early, or forget a note whose ban an operator has already pardoned by
 *  hand. Both are the same act to whoever is asking. */
export async function liftTimeout(
    game: TimeoutCommands,
    ownerId: string,
    installedAppId: string,
    player: string
): Promise<void> {
    await game.pardon(ownerId, installedAppId, player).catch(() => undefined);
    const kept = (await readPlayerTimeouts(installedAppId)).filter(
        (held) => held.player.toLowerCase() !== player.toLowerCase()
    );
    await patchInstallConfig(installedAppId, { [TIMEOUTS_KEY]: kept });
}

/**
 * Lift every timeout that has run out, and report how many that was.
 *
 * Best effort per player: a server that is not answering keeps its notes and is
 * swept again next time, because forgetting the note would leave the ban on
 * forever - the failure this whole file exists to prevent.
 */
export async function sweepTimeouts(
    game: TimeoutCommands,
    ownerId: string,
    installedAppId: string
): Promise<number> {
    const held = await readPlayerTimeouts(installedAppId);
    const now = Date.now();
    const due = held.filter((entry) => Date.parse(entry.until) <= now);
    if (due.length === 0) return 0;
    const lifted: string[] = [];
    for (const entry of due) {
        const pardoned = await game
            .pardon(ownerId, installedAppId, entry.player)
            .then(() => true)
            .catch(() => false);
        if (pardoned) lifted.push(entry.player.toLowerCase());
    }
    if (lifted.length === 0) return 0;
    await patchInstallConfig(installedAppId, {
        [TIMEOUTS_KEY]: held.filter((entry) => !lifted.includes(entry.player.toLowerCase()))
    });
    return lifted.length;
}

/**
 * The timeouts on one server, from its own record.
 *
 * Always re-read rather than taken from a caller's copy: one is written from a
 * screen while the cron sweeps from somewhere else, and a stale list would
 * resurrect a note that had just been lifted.
 */
export async function readPlayerTimeouts(installedAppId: string): Promise<PlayerTimeout[]> {
    const row = await prisma.installedApp.findUnique({ where: { id: installedAppId }, select: { config: true } });
    return readTimeouts(readInstallConfig(row?.config));
}
