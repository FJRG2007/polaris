/**
 * What happens to a game server, told to the automations listening for it.
 *
 * Said where it happens - the power switch and the automation step that does
 * the same, the minute sweep that stops a crash loop, the roster pass that sees
 * somebody arrive - and only to automations whose runner may see that install,
 * by the check its screen makes.
 */

import type * as core from "@polaris/core";
import { isUuid } from "@/lib/uuid";
import type { SessionUser } from "@/lib/session";
import { isGameServerApp } from "@/lib/apps/catalog";
import { installRef } from "@/lib/apps/install-access";
import { resourceAccess } from "@/lib/resource-access";
import { getInstalledApp } from "@/lib/apps/install-service";
import { emitAppEvent } from "./app-events";

type GameServerEvent =
    "game-server.started" | "game-server.stopped" | "game-server.crashed" | "game-server.player-joined";

/** What each event carries beyond the server itself. */
type Extra<Name extends GameServerEvent> = Omit<
    core.AppEventPayload<Name>,
    "installId" | "name" | "game"
>;

export async function announceGameServerEvent<Name extends GameServerEvent>(
    ownerId: string,
    installId: string,
    name: Name,
    extra: Extra<Name>,
    /** What makes it once-only, beside the server. */
    key: string
): Promise<boolean> {
    if (!isUuid(installId)) return false;
    const install = await getInstalledApp(ownerId, installId).catch(() => null);
    if (!install || !isGameServerApp(install.catalogId)) return false;
    return emitAppEvent(
        name,
        {
            ...extra,
            installId,
            name: install.name.slice(0, 200),
            game: install.catalogId.slice(0, 64)
        } as core.AppEventPayload<Name>,
        {
            key: `${installId}:${key}`,
            mayReceive: async (runner) => {
                const user: SessionUser = { ...runner, email: "", name: "", sessionId: "" };
                return (await resourceAccess(user, installRef(installId), "deploy.read")) !== null;
            }
        }
    );
}

export async function announceGameServer(
    ownerId: string,
    installId: string,
    running: boolean
): Promise<void> {
    // One event per switch: a minute bucket keeps a retried request from doubling it.
    await announceGameServerEvent(
        ownerId,
        installId,
        running ? "game-server.started" : "game-server.stopped",
        {},
        String(Math.floor(Date.now() / 60_000))
    );
}
