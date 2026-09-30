/**
 * Who is playing Minecraft on one of this instance's servers right now, for the
 * card beside their face: "Playing Minecraft - Survival".
 *
 * Nothing is asked of any server. The activity sweep already keeps the open
 * visits (`GamePlayerSession` with no `leftAt`) a minute at a time, so this is
 * two indexed reads for a page of faces, which is what it has to be: it runs on
 * every presence refresh of every screen.
 *
 * Which player is which account is the same question the chat relay answers
 * (`relayReady` in `chat-relay`), minus the one part that reads a container's
 * log. A link an operator made between a player and an account counts where the
 * account agrees with it (`link-agreement`) - the server is the account's own,
 * the name is the Minecraft account it connected, or the link follows the
 * account's sign-ins (whose addresses the join guard already enforces). A link
 * that only says who somebody is is the operator's word alone, and publishing
 * where somebody is on one person's say-so is exactly what this must not do.
 */

import { prisma } from "@polaris/db";
import { gameOfServer } from "@polaris/core";
import { accountAgrees, connectedMinecraftNames } from "../link-agreement";

/** One visit, as the dashboard's presence card reads it. */
export interface MinecraftVisit {
    readonly userId: string;
    readonly game: string;
    readonly server: string;
    readonly since: Date;
    readonly installedAppId: string;
    readonly gameId: string;
    /** The server's own icon (`server-icon.png`), which any signed-in reader may
     *  see - the game shows it to anybody who lists the server. The card falls
     *  back to the game's mark when there is none. */
    readonly imageUrl: string;
}

export async function playingMinecraftNow(
    userIds: readonly string[]
): Promise<MinecraftVisit[]> {
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return [];
    const links = await prisma.gamePlayerLink.findMany({
        where: { userId: { in: wanted } },
        select: { installedAppId: true, player: true, userId: true, followSignIns: true }
    });
    if (links.length === 0) return [];

    const [installs, ownNames] = await Promise.all([
        prisma.installedApp.findMany({
            where: {
                id: { in: [...new Set(links.map((link) => link.installedAppId))] },
                status: { not: "removed" }
            },
            select: { id: true, ownerId: true, catalogId: true, name: true }
        }),
        connectedMinecraftNames(links.map((link) => link.userId))
    ]);
    const minecraft = new Map(
        installs
            .filter((install) => gameOfServer(install.catalogId)?.id === "minecraft")
            .map((install) => [install.id, install])
    );
    if (minecraft.size === 0) return [];

    const agreed = links.filter((link) => {
        const install = minecraft.get(link.installedAppId);
        if (!install) return false;
        return accountAgrees(link, { ownerId: install.ownerId, minecraft: true }, ownNames);
    });
    if (agreed.length === 0) return [];

    const open = await prisma.gamePlayerSession.findMany({
        where: {
            installedAppId: { in: [...new Set(agreed.map((link) => link.installedAppId))] },
            leftAt: null
        },
        select: { installedAppId: true, name: true, joinedAt: true },
        // Newest first, so that of two left open by an interrupted pass the card
        // says when the visit they are on began, not an older one.
        orderBy: { joinedAt: "desc" }
    });
    const visits: MinecraftVisit[] = [];
    for (const link of agreed) {
        const visit = open.find(
            (row) =>
                row.installedAppId === link.installedAppId &&
                row.name.toLowerCase() === link.player.toLowerCase()
        );
        if (!visit) continue;
        const install = minecraft.get(link.installedAppId)!;
        visits.push({
            userId: link.userId,
            game: gameOfServer(install.catalogId)?.name ?? "Minecraft",
            server: install.name,
            since: visit.joinedAt,
            installedAppId: install.id,
            gameId: gameOfServer(install.catalogId)?.id ?? "minecraft",
            imageUrl: `/api/apps/installed/${install.id}/minecraft/card-icon`
        });
    }
    return visits;
}

/**
 * The accounts behind these players on one server, for telling their screens
 * that they arrived or left. Every link counts here, agreed or not: this only
 * decides whose presence is asked about again, and the asking applies the rule.
 */
export async function accountsOfPlayers(
    installedAppId: string,
    names: readonly string[]
): Promise<string[]> {
    if (names.length === 0) return [];
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const links = await prisma.gamePlayerLink.findMany({
        where: { installedAppId },
        select: { player: true, userId: true }
    });
    return [
        ...new Set(
            links.filter((link) => wanted.has(link.player.toLowerCase())).map((link) => link.userId)
        )
    ];
}
