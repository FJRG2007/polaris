/**
 * Writing a game's world to disk before its container goes down.
 *
 * A game server holds the world in memory and writes it out on its own schedule,
 * so whatever happened since the last autosave exists nowhere else. A stop that
 * does not finish gracefully is a kill, and what a kill costs is the last few
 * minutes everybody played - a base, a tame, an evening. So nothing that takes a
 * server down may do it without asking the game to save first.
 *
 * This is the "any game" version of that, and it exists because the rule was only
 * being kept in one of the four places that need it: stopping from the list did
 * flush, and stopping from the server's own page did not, and neither redeploy did
 * at all - while a redeploy destroys and recreates the container, which is the
 * most destructive of the three.
 *
 * Best effort by design. A server that is already down, still installing, or not
 * answering has nothing to flush, and a failure here must never be what stops an
 * operator from restarting something that is wedged - the reason they are pressing
 * the button is usually that it is not well.
 */

import { prisma } from "@polaris/db";
import { saveArkWorld } from "@/lib/apps/ark/service";
import { gameOfServer } from "@/lib/apps/games-catalog";
import { flushWorldForStop } from "@/lib/apps/minecraft/world-service";

export async function flushGameWorld(ownerId: string, installedAppId: string): Promise<void> {
    const install = await prisma.installedApp
        .findFirst({
            where: { id: installedAppId, ownerId, status: { not: "removed" } },
            select: { catalogId: true }
        })
        .catch(() => null);
    // Anything that is not a game server has no world to write, which is most of
    // what these actions are called for.
    const game = install ? gameOfServer(install.catalogId) : null;
    if (!game) return;
    // A FiveM server holds no world of its own. What its resources have written
    // down is in whatever database they were pointed at, and Polaris has never
    // been told where that is - so there is genuinely nothing to flush, and
    // pretending otherwise would be a save that never happened.
    if (game.id === "fivem") return;
    if (game.id === "ark") {
        await saveArkWorld(ownerId, installedAppId).catch(() => undefined);
        return;
    }
    await flushWorldForStop(ownerId, installedAppId).catch(() => undefined);
}
