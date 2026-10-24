/**
 * A game server started or stopped, told to the automations listening for it.
 *
 * Said where the server is switched on or off - its own screen and the
 * automation step that does the same - and only to automations whose runner may
 * see that install, by the check its screen makes.
 */

import { isUuid } from "@/lib/uuid";
import type { SessionUser } from "@/lib/session";
import { isGameServerApp } from "@/lib/apps/catalog";
import { installRef } from "@/lib/apps/install-access";
import { resourceAccess } from "@/lib/resource-access";
import { getInstalledApp } from "@/lib/apps/install-service";
import { emitAppEvent } from "./app-events";

export async function announceGameServer(
    ownerId: string,
    installId: string,
    running: boolean
): Promise<void> {
    if (!isUuid(installId)) return;
    const install = await getInstalledApp(ownerId, installId).catch(() => null);
    if (!install || !isGameServerApp(install.catalogId)) return;
    const name = running ? "game-server.started" : "game-server.stopped";
    await emitAppEvent(
        name,
        { installId, name: install.name.slice(0, 200), game: install.catalogId.slice(0, 64) },
        {
            // One event per switch: a minute bucket keeps a retried request from doubling it.
            key: `${installId}:${Math.floor(Date.now() / 60_000)}`,
            mayReceive: async (runner) => {
                const user: SessionUser = { ...runner, email: "", name: "", sessionId: "" };
                return (await resourceAccess(user, installRef(installId), "deploy.read")) !== null;
            }
        }
    );
}
