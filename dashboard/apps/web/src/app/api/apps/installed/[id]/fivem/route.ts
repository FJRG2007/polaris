import { NextResponse } from "next/server";
import { gameServerFacts } from "@/lib/apps/games-service";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { primaryIdentifier } from "@/lib/apps/fivem/players";
import { requireGameServer } from "@/lib/apps/install-access";
import { readLastSeen } from "@/lib/apps/games-activity-service";
import { sweepGameSchedules } from "@/lib/apps/minecraft/schedule-service";
import {
    applyFivemAccess,
    applyPendingSetup,
    getFivemStatus,
    readFivemAccess,
    sweepFivemBans
} from "@/lib/apps/fivem/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Live state of an installed FiveM server: who is online, what it is costing, who
 * is allowed on it, and what is still in the way of players outside this network.
 *
 * The lists are handed over on the way past. A server created a minute ago was
 * still starting when the decision about who may join it was made, and this poll
 * is the earliest moment the door can actually be told - so the same walk that
 * reads the server also gives it whatever it has not been given. The cron does it
 * too, on its own schedule; an instance with no cron configured would otherwise
 * have a server that never lets its owner in.
 *
 * Everything that does not need the server itself runs beside the read that does,
 * not after it. A server still loading its resources answers nothing for a while,
 * and holding the address and the player list behind that would leave a page whose
 * facts were all in the database sitting empty anyway.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const { access: server } = await requireGameServer("games.read", id);
    // Who was last seen when is a database read per player, so it is gathered for
    // the screen that shows it rather than on every poll. The resource list has a
    // read of its own, on the screen that draws it: it is a folder walk inside the
    // container and nothing else on this page wants it.
    const wantsPlayers = new URL(request.url).searchParams.get("players") === "1";
    try {
        const [status, reach, held, facts] = await Promise.all([
            getFivemStatus(server.ownerId, id),
            reachAdviceFor(id, true).catch(() => null),
            readFivemAccess(server.ownerId, id).catch(() => null),
            // Where a player connects is worked out for every game in one place, so
            // this page and the row in the list cannot disagree about it.
            gameServerFacts(server.ownerId, id).catch(() => null)
        ]);
        // Everything the server was created with, handed over as soon as it has
        // files to write it into. Does nothing at all on every poll after the
        // first, which is what it is written to do.
        if (status.containerRunning) await applyPendingSetup(server.ownerId, id).catch(() => false);
        // Only worth trying against a server that is answering; against one that is
        // not it is a failing exec on every poll. It writes nothing when nothing
        // has changed - unless the server is not running the resource that enforces
        // it, which is a container that has lost what it was handed.
        const access = status.answering
            ? await applyFivemAccess(server.ownerId, id, status.guardRunning === false)
                  .then((applied) => (applied > 0 ? readFivemAccess(server.ownerId, id).catch(() => held) : held))
                  .catch(() => held)
            : held;
        // The schedule, on the server it belongs to and with the player count this
        // poll has already paid for. The cron sweeps every server on its own
        // schedule and the Game servers page sweeps the ones it lists; neither
        // covers somebody sitting on this page with no cron configured, which is
        // exactly where "I set a schedule and nothing happened" comes from.
        await sweepGameSchedules(server.ownerId, new Date(), {
            only: id,
            known: new Map([[id, status.answering ? status.players.length : null]])
        }).catch(() => undefined);
        // And the bans that were only ever meant to last an hour, for the same
        // reason: without something coming back to lift one, a ten-minute cool-off
        // is a permanent ban.
        if (status.answering) await sweepFivemBans(server.ownerId, id).catch(() => 0);
        // When each of them was last on. Polaris' own record rather than the
        // game's, which knows who is connected this second and nothing about a
        // minute ago. Asked by identifier, which is the half of a row that is the
        // person - the list holds a label somebody typed and a visit was recorded
        // under whatever name the player was using.
        const seen = wantsPlayers
            ? await readLastSeen(id, [
                  ...status.players.map((player) => ({ name: player.name, id: primaryIdentifier(player) })),
                  ...(access?.allowList ?? []).map((player) => ({ name: player.label, id: player.identifier }))
              ]).catch(() => ({}))
            : {};
        return NextResponse.json({ status, reach, access, seen, address: facts?.address ?? null });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
