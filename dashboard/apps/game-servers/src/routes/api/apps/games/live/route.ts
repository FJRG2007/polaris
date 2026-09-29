import { messageText } from "../../../../../screens/game-words";
import { NextResponse } from "next/server";
import { gameWords } from "../../../../../screens/game-words";
import { listGameServerLive } from "../../../../../lib/games-service";
import { sweepWatchedGameSchedules } from "../../../../../lib/minecraft/schedule-service";
import { host } from "@polaris/app-host";

const { requirePermissionAny } = host.session;
const { reachableInstallIds } = host.appsInstallAccess;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Who is on each server right now. Apart from the list itself because it is a
 *  round trip into every running container: the table is painted from the other
 *  endpoint and only the player counts wait on this one. */
export async function GET(): Promise<Response> {
    const user = await requirePermissionAny("games.read");
    try {
        const granted = await reachableInstallIds(user, "games.read");
        const servers = await listGameServerLive(user.id, granted);
        // Schedules fire from the cron when one is configured. Sweeping here too
        // means they also fire on an instance that has none, and it costs nothing
        // extra: the read a sleep decision needs is the one just made.
        //
        // Only over this caller's own servers. Somebody looking at a server they
        // were invited to help with should not be the reason it starts or stops,
        // and the owner's own poll - or the cron - is what decides that.
        await sweepWatchedGameSchedules(user.id, {
            // Null for a server that did not answer: nought would be the sweep
            // reading silence as an empty world and stopping it.
            known: new Map(
                servers.map((server) => [server.id, server.answering ? server.online : null])
            )
        }).catch(() => undefined);
        return NextResponse.json({ servers });
    } catch (caught) {
        return NextResponse.json(
            {
                error:
                    caught instanceof Error
                        ? await messageText(caught.message)
                        : (await gameWords("games"))("errors.couldNotReadYourGame")
            },
            { status: 400 }
        );
    }
}
