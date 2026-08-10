import { NextResponse } from "next/server";
import { gameServerFacts } from "@/lib/apps/games-service";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { requireGameServer } from "@/lib/apps/install-access";
import { applyAllowList, getArkStatus, readArkAccess } from "@/lib/apps/ark/service";

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
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
    const { id } = await params;
    const { access: server } = await requireGameServer("games.read", id);
    try {
        const status = await getArkStatus(server.ownerId, id);
        // Only worth trying against a server that is answering; against one that is
        // not it is a failing exec on every poll.
        if (status.answering) await applyAllowList(server.ownerId, id).catch(() => 0);
        const [reach, allow, facts] = await Promise.all([
            reachAdviceFor(id, true).catch(() => null),
            readArkAccess(server.ownerId, id).catch(() => null),
            // Where a player connects is worked out for every game in one place, so
            // this page and the row in the list cannot disagree about it.
            gameServerFacts(server.ownerId, id).catch(() => null)
        ]);
        return NextResponse.json({ status, reach, access: allow, address: facts?.address ?? null });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
