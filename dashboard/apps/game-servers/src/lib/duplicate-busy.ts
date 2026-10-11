/**
 * Which servers a copy in progress is holding, so nothing else starts them.
 *
 * A copy stops its source and reads its files; a schedule, a player knocking or
 * somebody pressing Start in the middle of that would bring the world up while
 * it is being read, and the copy would be of a world neither server ever had.
 * The copy itself is held too: starting it before its files are in place is a
 * fresh, empty server under the copy's name.
 *
 * Its own small module so the start paths can ask without loading the copying.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { gameMessage } from "./game-message";
import { DUPLICATE_KEY, holdsSource, readDuplicateState } from "./duplicate-plan";

const { readInstallConfig } = host.appsInstallConfig;

/** Ids of every server a copy holds right now: the sources it stopped and the
 *  copies still being made. */
export async function heldByCopies(): Promise<Set<string>> {
    const rows = await prisma.installedApp.findMany({
        where: { status: "installing", config: { contains: `"${DUPLICATE_KEY}":{` } },
        select: { id: true, config: true },
        take: 200
    });
    const held = new Set<string>();
    for (const row of rows) {
        const state = readDuplicateState(readInstallConfig(row.config));
        if (!state || state.stage === "failed") continue;
        held.add(row.id);
        if (holdsSource(state.stage)) held.add(state.from);
    }
    return held;
}

/** Refuse to start a server a copy is holding, in words the reader can act on. */
export async function refuseWhileCopying(installedAppId: string): Promise<void> {
    if ((await heldByCopies()).has(installedAppId))
        throw new Error(gameMessage("games", "duplicate.busy"));
}
