/**
 * Games: `/games` is the library and `/games/<id>` one game, full screen.
 * Whoever lacks `arcade.open` is refused here, the same way the server refuses
 * every other app page somebody was not given.
 */

import { host } from "@polaris/app-host";
import { notFound } from "next/navigation";
import { findGame } from "../../../games/registry";
import { GamesScreen } from "../../../screens/library";
import { GamePlayer } from "../../../screens/game-player";

export const dynamic = "force-dynamic";

export default async function GamesPage({
    params
}: {
    params: Promise<Record<string, string | string[]>>;
}) {
    await host.session.requirePermission("arcade.open");
    const raw = (await params).path;
    const path = Array.isArray(raw) ? raw : raw ? [raw] : [];
    if (path.length > 1) notFound();
    const [id] = path;
    if (id !== undefined) {
        if (!findGame(id)) notFound();
        return <GamePlayer gameId={id} />;
    }
    // Rooms are offered only to whoever may play with others, the same check
    // every room action asks again.
    const user = await host.session.requireUser();
    const together = await host.session.sessionCan(user, "arcade.calls");
    return <GamesScreen together={together} />;
}
