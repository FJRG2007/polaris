/**
 * Visits recorded under a rank's symbol instead of the player's name.
 *
 * Before `list` was read through a team prefix (`parse.playerOfEntry`), a
 * ranked player's `✦ [VIP] Steve` was stored as a player called `✦`: their
 * visits went to a name nobody has, so they never showed as playing and nothing
 * could link them to an account. The parser is fixed; this repairs what it
 * already wrote, once a boot, so an install that took the update is corrected
 * without anybody doing anything.
 *
 * A stored name is a rank symbol when no word in it can be a player's name.
 * Where exactly one player holds the only rank with that symbol, the visit is
 * theirs and is renamed to them. Otherwise it cannot be told whose it was, and a
 * visit by nobody is removed rather than kept as a phantom player.
 */

import { prisma } from "@polaris/db";
import { playerOfEntry } from "./parse";
import { host } from "@polaris/app-host";
import { gameOfServer } from "@polaris/core";
import { readRanks, type Rank } from "./ranks";

/** The most phantom visits read per server in one pass. */
const MOST_REPAIRED = 5000;

/** Who a phantom name stands for, or null when it cannot be told. */
export function ownerOfSymbol(name: string, ranks: readonly Rank[]): string | null {
    const symbol = name.trim();
    if (!symbol) return null;
    const holding = ranks.filter((rank) => rank.symbol === symbol);
    if (holding.length !== 1) return null;
    const players = holding[0]?.players ?? [];
    return players.length === 1 ? (players[0] ?? null) : null;
}

/** Repair every Minecraft server's phantom visits. Never throws. */
export async function repairRankSymbolVisits(): Promise<void> {
    try {
        const installs = await prisma.installedApp.findMany({
            where: { status: { not: "removed" } },
            select: { id: true, catalogId: true, config: true }
        });
        for (const install of installs) {
            if (gameOfServer(install.catalogId)?.id !== "minecraft") continue;
            await repairServer(install.id, install.config).catch((caught: unknown) =>
                console.error("polaris: phantom player visits could not be repaired:", caught)
            );
        }
    } catch (caught) {
        console.error("polaris: phantom player visits could not be repaired:", caught);
    }
}

async function repairServer(installedAppId: string, config: string): Promise<void> {
    // Every stored name with no letter, digit or underscore in it, which is
    // what `playerOfEntry` rejects; checked again in code below.
    const visits = await prisma.$queryRaw<{ id: string; name: string }[]>`
        SELECT "id", "name" FROM "GamePlayerSession"
        WHERE "installedAppId" = ${installedAppId}::uuid AND "name" !~ '[A-Za-z0-9_]'
        LIMIT ${MOST_REPAIRED}`;
    const phantom = visits.filter((visit) => playerOfEntry(visit.name) === null);
    if (phantom.length === 0) return;
    const { ranks } = readRanks(host.appsInstallConfig.readInstallConfig(config));
    const owners = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const visit of phantom) {
        const owner = ownerOfSymbol(visit.name, ranks);
        if (!owner) {
            orphans.push(visit.id);
            continue;
        }
        owners.set(owner, [...(owners.get(owner) ?? []), visit.id]);
    }
    for (const [owner, ids] of owners) {
        await prisma.gamePlayerSession.updateMany({
            where: { id: { in: ids } },
            data: { name: owner }
        });
    }
    if (orphans.length > 0)
        await prisma.gamePlayerSession.deleteMany({ where: { id: { in: orphans } } });
}
