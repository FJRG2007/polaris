import { after, NextResponse } from "next/server";
import { reachAdviceFor } from "../../../../../../lib/minecraft/reach";
import { readLastSeen } from "../../../../../../lib/games-activity-service";
import { sweepGameSchedules } from "../../../../../../lib/minecraft/schedule-service";
import { drainQueue, pendingFor } from "../../../../../../lib/minecraft/queue-service";
import { sweepInventorySnapshots } from "../../../../../../lib/minecraft/inventory-service";
import { rememberRoster, rememberedRoster } from "../../../../../../lib/minecraft/roster-memory";
import { rememberLevels, rememberedLevels } from "../../../../../../lib/minecraft/level-memory";
import { readPlayerTimeouts, sweepTimeouts } from "../../../../../../lib/minecraft/timeout-service";
import { enforcePlayerAddresses, listPlayerAccess } from "../../../../../../lib/minecraft/player-access";
import {
    getPlayerLevels,
    getPlayerSessions,
    getServerFirewall,
    getServerRoster,
    getServerStatus
} from "../../../../../../lib/minecraft/service";
import { host } from "@polaris/app-host";

const { requireGameServer } = host.appsInstallAccess;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Live state of an installed Minecraft server: who is online, where to reach it,
 *  and - when asked for - the ops, whitelist and ban roster. Polled by the app's
 *  panel; the roster costs three reads inside the container, so it is only
 *  gathered for the screen that shows it.
 *
 *  The reach comes with it because it is the other half of "where to reach it":
 *  the operator makes the forward with this page open, and the answer has to reach
 *  them without a reload. The knock behind it is rate limited in `probeReach`, so
 *  the five-second poll costs one attempt every thirty seconds. */
export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
    const { id } = await params;
    // Resolved once, here: the reads below all run on the owner's shelf, and this
    // is what decides whether the caller may see any of it. Named `server` because
    // `access` is already the player access list further down.
    const { access: server } = await requireGameServer("games.read", id);
    const wantsRoster = new URL(request.url).searchParams.get("roster") === "1";
    try {
        // The read that reaches the container runs beside the ones that do not,
        // rather than in front of them: asking a server that is generating its
        // world takes as long as the timeout, and everything behind it - the
        // address, the list of who may join, the port advice - is a database row
        // that was ready immediately.
        const [status, reach, access] = await Promise.all([
            getServerStatus(server.ownerId, id),
            reachAdviceFor(id, true).catch(() => null),
            // One indexed query, and unlike the roster it does not go near the
            // container - so it rides on every poll rather than only the moderation
            // screen's. The overview needs it too: a server nobody is registered on
            // is one nobody can join, and that has to be said where the address is,
            // not on a tab somebody has to think to open.
            listPlayerAccess(server.ownerId, id).catch(() => null)
        ]);
        // A server that is not answering has no roster to report, and asking for one
        // would only stack up failing execs behind a poll.
        // Named rather than destructured by position: this list has grown twice,
        // and a name that silently slid onto its neighbour's result is what shipped
        // the enforcement report to the screen as if it were the session history.
        const online = status.answering ? status.players.players : [];
        const gathered = await Promise.all([
            wantsRoster && status.answering ? getServerRoster(server.ownerId, id) : null,
            wantsRoster ? getServerFirewall(server.ownerId, id).catch(() => null) : null,
            // What level each of them is on. Only for the screen that has a
            // column for it, and only for players who are actually standing on
            // the server - it is one command each, and nobody who is offline has
            // an answer. Beside the roster rather than after it, so the table is
            // not held for one read behind the other.
            wantsRoster && online.length > 0
                ? getPlayerLevels(server.ownerId, id, online).catch(() => ({}))
                : ({} as Record<string, number>),
            // Who arrived and who left, which only the log records. Gathered for
            // the screen that shows it, like the roster - and unlike the roster it
            // survives a server that has stopped answering, because a history is
            // most wanted about a server that has just gone quiet.
            wantsRoster ? getPlayerSessions(server.ownerId, id).catch(() => []) : [],
            // Timeouts end by somebody coming back to lift them. The cron does
            // that on its own schedule; an instance with no cron configured would
            // otherwise hand out cool-offs that never end, so opening the screen
            // that grants them is also when the due ones are lifted.
            wantsRoster && status.answering ? sweepTimeouts(server.ownerId, id).catch(() => 0) : 0
        ] as const);
        const [live, firewall, levels] = gathered;
        const sessions = gathered[3];
        /*
         * What the server last said about who may play on it.
         *
         * The roster is read out of files inside the container, so a server that
         * is off has none - and the screen drew the whitelist switch as off,
         * which is not "we could not ask" but the opposite of the truth for a
         * server that is closed by default and lets nobody in who is not listed.
         *
         * Written whenever the server does answer and read back only when it does
         * not. Nothing becomes editable by being remembered: the screen's controls
         * are gated on whether the server is answering, not on whether a roster
         * arrived.
         */
        const [kept, timeouts, lastLevels, pending] = await Promise.all([
            wantsRoster && !live ? rememberedRoster(id).catch(() => null) : null,
            wantsRoster ? readPlayerTimeouts(id).catch(() => []) : [],
            // The level each of them was last seen on, for the rows of players
            // who are not on right now.
            wantsRoster ? rememberedLevels(id).catch(() => ({})) : {},
            wantsRoster ? pendingFor(id).catch(() => []) : []
        ]);
        const roster = live ?? kept?.roster ?? null;
        // When Polaris last watched each of them, for the rows the log no longer
        // reaches back to: it holds only the tail that was asked for and starts
        // again empty every time the container is replaced, so a regular who has
        // not been on since this morning can have nothing in it. One indexed
        // query, and only for the screen with a column for it.
        const seen = wantsRoster
            ? await readLastSeen(
                  id,
                  [
                      ...status.players.players,
                      ...(roster?.ops ?? []),
                      ...(roster?.whitelist ?? []),
                      ...(roster?.bans ?? []).map((ban) => ban.name),
                      ...(access?.rules ?? []).map((rule) => rule.username),
                      ...sessions.map((event) => event.name)
                      // Minecraft reports no second id on its roster, so a visit
                      // here is recorded under the account name alone.
                  ].map((name) => ({ name, id: null }))
              ).catch(() => ({}))
            : {};

        /*
         * The work this poll triggers but the screen does not wait for.
         *
         * Each of these reaches into the container or walks a table, and none of
         * their results is in the answer - so they run once the answer has been
         * sent rather than holding it open.
         *
         * - The roster and the levels are written down, so the next first paint
         *   has them before any container is asked.
         * - Opening the moderation screen is also when the player list gets
         *   applied to whoever is already on. The cron does this on its own
         *   schedule; a deployment without cron configured would otherwise have
         *   rules that only ever took effect on the next join.
         * - The queue is drained here as well as from the cron because a decision
         *   waiting for somebody to join should land while an operator is
         *   watching the screen that told them to wait.
         * - The inventory snapshot is guarded by each row's own age, so it reads a
         *   bag every ten minutes rather than every poll.
         * - The schedule, with the player count this poll has already paid for:
         *   neither the cron nor the Game servers page covers somebody sitting on
         *   this page with no cron configured.
         */
        after(async () => {
            if (live) await rememberRoster(id, live).catch(() => undefined);
            if (Object.keys(levels).length > 0)
                await rememberLevels(id, levels).catch(() => undefined);
            if (wantsRoster) await enforcePlayerAddresses(server.ownerId, id).catch(() => null);
            if (online.length > 0) {
                await drainQueue(server.ownerId, id, online).catch(() => null);
                await sweepInventorySnapshots(server.ownerId, id, online).catch(() => 0);
            }
            await sweepGameSchedules(server.ownerId, new Date(), {
                only: id,
                // What this poll already found out, silence included, so the
                // sweep never asks the same container the same question twice.
                known: new Map([[id, status.answering ? status.players.online : null]])
            }).catch(() => undefined);
        });
        // The log's timestamps are the server's, so the clock they are read
        // against has to be too - a browser minutes out would otherwise report
        // somebody as still arriving long after they left.
        return NextResponse.json({
            status,
            reach,
            roster,
            // When that roster was read, for the screen to say so. Null while the
            // server is answering, which is what "this is current" looks like.
            rosterAsOf: kept?.at ?? null,
            firewall,
            access,
            sessions,
            seen,
            timeouts,
            levels,
            lastLevels,
            pending,
            now: new Date().toISOString()
        });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
