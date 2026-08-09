import { NextResponse } from "next/server";
import { requireGameServer } from "@/lib/apps/install-access";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { drainQueue, pendingFor } from "@/lib/apps/minecraft/queue-service";
import { sweepInventorySnapshots } from "@/lib/apps/minecraft/inventory-service";
import { readPlayerTimeouts, sweepTimeouts } from "@/lib/apps/minecraft/timeout-service";
import { enforcePlayerAddresses, listPlayerAccess } from "@/lib/apps/minecraft/player-access";
import {
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
        const status = await getServerStatus(server.ownerId, id);
        // A server that is not answering has no roster to report, and asking for one
        // would only stack up failing execs behind a poll.
        // Named rather than destructured by position: this list has grown twice,
        // and a name that silently slid onto its neighbour's result is what shipped
        // the enforcement report to the screen as if it were the session history.
        const gathered = await Promise.all([
            reachAdviceFor(id, true).catch(() => null),
            wantsRoster && status.answering ? getServerRoster(server.ownerId, id) : null,
            wantsRoster ? getServerFirewall(server.ownerId, id).catch(() => null) : null,
            // One indexed query, and unlike the roster it does not go near the
            // container - so it rides on every poll rather than only the moderation
            // screen's. The overview needs it too: a server nobody is registered on
            // is one nobody can join, and that has to be said where the address is,
            // not on a tab somebody has to think to open.
            listPlayerAccess(server.ownerId, id).catch(() => null),
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
        const [reach, roster, firewall, access] = gathered;
        const sessions = gathered[5];
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
        const pending = wantsRoster ? await pendingFor(id).catch(() => []) : [];
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
