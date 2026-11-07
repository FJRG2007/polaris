/**
 * Giving newcomers on every running Lucky blocks server their starting lucky
 * blocks (`lucky-starter.ts`), from the minute sweep.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import * as starter from "./lucky-starter";
import { withServerContainer } from "./service";
import { BLUEPRINT_KEY, MAP_KEY } from "../games-create";

const { readInstallConfig } = host.appsInstallConfig;

export async function sweepLuckyStarters(): Promise<{ served: number }> {
    const rows = await prisma.installedApp.findMany({
        where: { status: { not: "removed" }, catalogId: "minecraft" },
        select: { id: true, ownerId: true, config: true }
    });
    let served = 0;
    for (const row of rows) {
        const config = readInstallConfig(row.config);
        if (!starter.wantsStarter(config[BLUEPRINT_KEY], config[MAP_KEY])) continue;
        try {
            const sent = await withServerContainer(row.ownerId, row.id, async (server) => {
                if (!server.running || server.edition !== "java") return false;
                await server.sayAll(starter.starterLines());
                return true;
            });
            if (sent) served += 1;
        } catch (error) {
            // A server that is starting, stopping or unreachable is asked again on
            // the next sweep; nobody has been tagged, so nobody is skipped.
            console.warn("polaris: lucky block starters failed", row.id, String(error));
        }
    }
    return { served };
}
