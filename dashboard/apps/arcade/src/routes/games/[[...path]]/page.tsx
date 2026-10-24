/**
 * Games: `/games` is the library and `/games/<id>` one game, full screen.
 * Whoever lacks `arcade.open` is refused here, the same way the server refuses
 * every other app page somebody was not given.
 */

import { PAGE_FILL } from "@polaris/ui";
import { host } from "@polaris/app-host";
import { notFound } from "next/navigation";
import { findGame } from "../../../games/registry";
import { GamesScreen } from "../../../screens/library";

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
    if (id !== undefined && !findGame(id)) notFound();
    return (
        <div className={PAGE_FILL}>
            <GamesScreen gameId={id ?? null} />
        </div>
    );
}
