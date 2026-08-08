import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/session";
import { reachAdviceFor } from "@/lib/apps/minecraft/reach";
import { enforcePlayerAddresses, listPlayerAccess } from "@/lib/apps/minecraft/player-access";
import { getServerFirewall, getServerRoster, getServerStatus } from "@/lib/apps/minecraft/service";

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
    const user = await requirePermission("games.read");
    const { id } = await params;
    const wantsRoster = new URL(request.url).searchParams.get("roster") === "1";
    try {
        // Ownership first: everything below reads this install, and the status call
        // is what refuses one that is not this user's.
        const status = await getServerStatus(user.id, id);
        // A server that is not answering has no roster to report, and asking for one
        // would only stack up failing execs behind a poll.
        const [reach, roster, firewall, access] = await Promise.all([
            reachAdviceFor(id, true).catch(() => null),
            wantsRoster && status.answering ? getServerRoster(user.id, id) : null,
            wantsRoster ? getServerFirewall(user.id, id).catch(() => null) : null,
            // One query, and it is what the moderation screen is really about now:
            // the game's own lists say who, and this says who from where.
            wantsRoster ? listPlayerAccess(user.id, id).catch(() => null) : null,
            // Opening the moderation screen is also when the list gets applied to
            // whoever is already on. The cron does this on its own schedule; a
            // deployment without cron configured would otherwise have rules that
            // only ever took effect on the next join.
            wantsRoster ? enforcePlayerAddresses(user.id, id).catch(() => null) : null
        ]);
        return NextResponse.json({ status, reach, roster, firewall, access });
    } catch (caught) {
        return NextResponse.json(
            { error: caught instanceof Error ? caught.message : "Could not read the server" },
            { status: 400 }
        );
    }
}
