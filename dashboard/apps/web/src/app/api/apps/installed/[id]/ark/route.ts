import { NextResponse } from "next/server";
import { gameServerFacts } from "@/lib/apps/games-service";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { requireGameServer } from "@/lib/apps/install-access";
import { sweepArkTimeouts } from "@/lib/apps/ark/timeout-service";
import { readPlayerTimeouts } from "@/lib/apps/player-timeout-service";
import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";
import {
    applyAllowList,
    getArkStatus,
    readArkAccess,
    readArkAdmins,
    readArkProfiles
} from "@/lib/apps/ark/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live state of an installed ARK server: who is online, what it is costing, who is
 * allowed on it, and what is still in the way of players outside this network.
 *
 * The allow list is handed over on the way past. A server created closed has
 * nobody on it that it knows about - it was still installing thirty gigabytes when
 * the decision was made - so the poll of the screen an operator is watching is the
 * earliest moment the door can actually open. The cron walk does the same on its
 * own schedule; an instance with no cron configured would otherwise have a server
 * that never lets its owner in.
 *
 * Everything that does not need the server itself runs beside the read that does,
 * not after it. Asking an ARK server anything is a command inside its container and
 * a loading world does not answer for minutes, which used to hold the address, the
 * player list and the port advice behind it - so a page whose facts were all in the
 * database sat empty anyway.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const { access: server } = await requireGameServer("games.read", id);
    // The survivors and the admin list are two more reads inside the container, so
    // they are gathered for the screen that shows them rather than on every poll.
    const wantsPlayers = new URL(request.url).searchParams.get("players") === "1";
    try {
        const [status, reach, allow, facts] = await Promise.all([
            getArkStatus(server.ownerId, id),
            reachAdviceFor(id, true).catch(() => null),
            readArkAccess(server.ownerId, id).catch(() => null),
            // Where a player connects is worked out for every game in one place, so
            // this page and the row in the list cannot disagree about it.
            gameServerFacts(server.ownerId, id).catch(() => null)
        ]);
        // Only worth trying against a server that is answering; against one that is
        // not it is a failing exec on every poll.
        const access = status.answering
            ? await applyAllowList(server.ownerId, id)
                  .then((applied) => (applied > 0 ? readArkAccess(server.ownerId, id).catch(() => allow) : allow))
                  .catch(() => allow)
            : allow;
        // The schedule, on the server it belongs to and with the player count this
        // poll has already paid for. The cron sweeps every server on its own
        // schedule and the Game servers page sweeps the ones it lists; neither
        // covers somebody sitting on this page with no cron configured, which is
        // exactly where "I set a schedule and nothing happened" comes from.
        await sweepGameSchedules(server.ownerId, new Date(), {
            only: id,
            // What this poll already found out, silence included, so the sweep
            // never asks the same container the same question twice.
            known: new Map([[id, status.answering ? status.players.length : null]])
        }).catch(() => undefined);
        // And the bans that were only ever meant to last an hour. Swept here for
        // the same reason the schedule is: an instance with no cron configured
        // would otherwise hand out timeouts that never end. Only against a server
        // that is answering - unbanning is a command inside the container.
        if (status.answering) await sweepArkTimeouts(server.ownerId, id).catch(() => 0);
        const timeouts = await readPlayerTimeouts(id).catch(() => []);
        // Who administers it, and what level each survivor is on. Both are files in
        // the container, so neither is asked of a server that is not up - and
        // neither is a reason to fail the poll: the screen draws without them.
        const [admins, profiles] = await Promise.all([
            wantsPlayers && status.containerRunning !== false
                ? readArkAdmins(server.ownerId, id).catch(() => [])
                : [],
            wantsPlayers && status.containerRunning !== false
                ? readArkProfiles(server.ownerId, id, [
                      ...status.players.map((player) => player.steamId),
                      ...(access?.players ?? []).map((player) => player.steamId)
                  ]).catch(() => ({}))
                : {}
        ]);
        return NextResponse.json({
            status,
            reach,
            access,
            timeouts,
            admins,
            profiles,
            address: facts?.address ?? null
        });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
