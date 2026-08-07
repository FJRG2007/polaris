/**
 * Every game server this owner runs, whatever edition, as one list.
 *
 * A game server is an installed marketplace app whose manifest declares the
 * game-server capability, so this is a view over the same installs the app pages
 * manage rather than a second place servers can exist. Each row carries what the
 * list actually shows - who is playing and where to connect - which is a live
 * read per server, gathered in parallel and never allowed to fail the list: a
 * server that is still booting is a row that says so, not a page that errors.
 */

import { prisma } from "@polaris/db";
import { appHasCapability, findApp } from "@/lib/apps/catalog";
import { editionOf, getServerStatus, type MinecraftEdition } from "@/lib/apps/minecraft/service";

export interface GameServerRow {
    readonly id: string;
    readonly name: string;
    readonly catalogId: string;
    readonly catalogName: string;
    readonly edition: MinecraftEdition;
    /** The machine it runs on. */
    readonly serverName: string | null;
    readonly running: boolean;
    readonly answering: boolean;
    readonly address: string | null;
    readonly online: number;
    readonly max: number;
    readonly players: readonly string[];
    /** Why it is not answering, when it is not. */
    readonly message: string | null;
}

/** The owner's game servers, newest first. */
export async function listGameServers(ownerId: string): Promise<GameServerRow[]> {
    const installs = await prisma.installedApp.findMany({
        where: { ownerId, status: { not: "removed" } },
        orderBy: { createdAt: "desc" }
    });
    const games = installs.filter((install) => {
        const manifest = findApp(install.catalogId);
        return manifest ? appHasCapability(manifest, "game-server") : false;
    });
    const targets = new Map(
        (
            await prisma.deployTarget.findMany({
                where: { id: { in: games.map((game) => game.targetId).filter((id): id is string => id !== null) } },
                select: { id: true, name: true }
            })
        ).map((target) => [target.id, target.name])
    );

    return Promise.all(
        games.map(async (install) => {
            const manifest = findApp(install.catalogId);
            const status = await getServerStatus(ownerId, install.id).catch(() => null);
            return {
                id: install.id,
                name: install.name,
                catalogId: install.catalogId,
                catalogName: manifest?.name ?? install.catalogId,
                edition: editionOf(install.catalogId),
                serverName: install.targetId ? (targets.get(install.targetId) ?? null) : null,
                running: status?.running ?? false,
                answering: status?.answering ?? false,
                address: status?.address ?? null,
                online: status?.players.online ?? 0,
                max: status?.players.max ?? 0,
                players: status?.players.players ?? [],
                message: status?.message ?? (status ? null : "This server is still being set up")
            };
        })
    );
}
