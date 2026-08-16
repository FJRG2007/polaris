import { NextResponse } from "next/server";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { requireGameServer } from "@/lib/apps/install-access";
import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";
import { drainQueue, pendingFor } from "@/lib/apps/minecraft/queue-service";
import { sweepInventorySnapshots } from "@/lib/apps/minecraft/inventory-service";
import { readPlayerTimeouts, sweepTimeouts } from "@/lib/apps/minecraft/timeout-service";
import { enforcePlayerAddresses, listPlayerAccess } from "@/lib/apps/minecraft/player-access";
import {
    getPlayerLevels,
    getPlayerSessions,
    getServerFirewall,
    getServerRoster,
    getServerStatus
} from "@/lib/apps/minecraft/service";

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
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
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
        const gathered = await Promise.all([
            wantsRoster && status.answering ? getServerRoster(server.ownerId, id) : null,
            wantsRoster ? getServerFirewall(server.ownerId, id).catch(() => null) : null,
            // Opening the moderation screen is also when the list gets applied to
            // whoever is already on. The cron does this on its own schedule; a
            // deployment without cron configured would otherwise have rules that
            // only ever took effect on the next join. Nothing reads the report.
            wantsRoster ? enforcePlayerAddresses(server.ownerId, id).catch(() => null) : null,
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
        const [roster, firewall] = gathered;
        const sessions = gathered[3];
        const timeouts = wantsRoster ? await readPlayerTimeouts(id).catch(() => []) : [];

        // Two passes that only cost anything when there is something to do, so
        // they can ride on a five-second poll: one indexed query each says no.
        //
        // The queue is drained here as well as from the cron because a decision
        // waiting for somebody to join should land while an operator is watching
        // the screen that told them to wait - and on an instance with no cron
        // configured, this is the only place it ever would.
        //
        // The snapshot is guarded by each row's own age, so it reads a bag every
        // ten minutes rather than every poll.
        const online = status.answering ? status.players.players : [];
        if (online.length > 0) {
            await drainQueue(server.ownerId, id, online).catch(() => null);
            await sweepInventorySnapshots(server.ownerId, id, online).catch(() => 0);
        }
        // What level each of them is on. Only for the screen that has a column for
        // it, and only for players who are actually standing on the server - it is
        // one command each, and nobody who is offline has an answer.
        const levels =
            wantsRoster && online.length > 0
                ? await getPlayerLevels(server.ownerId, id, online).catch(() => ({}))
                : {};
        const pending = wantsRoster ? await pendingFor(id).catch(() => []) : [];
        // The schedule, on the server it belongs to and with the player count this
        // poll has already paid for. The cron sweeps every server on its own
        // schedule and the Game servers page sweeps the ones it lists; neither
        // covers somebody sitting on this page with no cron configured, which is
        // exactly where "I set a schedule and nothing happened" comes from.
        await sweepGameSchedules(server.ownerId, new Date(), {
            only: id,
            // What this poll already found out, silence included, so the sweep
            // never asks the same container the same question twice.
            known: new Map([[id, status.answering ? status.players.online : null]])
        }).catch(() => undefined);
        // The log's timestamps are the server's, so the clock they are read
        // against has to be too - a browser minutes out would otherwise report
        // somebody as still arriving long after they left.
        return NextResponse.json({
            status,
            reach,
            roster,
            firewall,
            access,
            sessions,
            timeouts,
            levels,
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
