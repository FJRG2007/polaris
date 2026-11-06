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

/** The most open visits read to say who is playing: past it the cap on
 *  readers in `chat/game-relay` cuts the list anyway. */
const MOST_PLAYING = 2000;

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

/** A player-to-account link this rule lets speak for the account, with its server. */
interface AgreedLink {
    readonly userId: string;
    readonly player: string;
    readonly install: { id: string; ownerId: string; catalogId: string; name: string };
}

/**
 * The links of these accounts to players on a Minecraft server here that the
 * account agrees with - see the top of this file. Shared by "playing now" and
 * "played lately", so the two can never disagree about who somebody is.
 */
async function agreedMinecraftLinks(userIds: readonly string[]): Promise<AgreedLink[]> {
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

    const agreed: AgreedLink[] = [];
    for (const link of links) {
        const install = minecraft.get(link.installedAppId);
        if (!install) continue;
        if (!accountAgrees(link, { ownerId: install.ownerId, minecraft: true }, ownNames)) continue;
        agreed.push({ userId: link.userId, player: link.player, install });
    }
    return agreed;
}

export async function playingMinecraftNow(userIds: readonly string[]): Promise<MinecraftVisit[]> {
    const agreed = await agreedMinecraftLinks(userIds);
    if (agreed.length === 0) return [];

    const open = await prisma.gamePlayerSession.findMany({
        where: {
            installedAppId: { in: [...new Set(agreed.map((link) => link.install.id))] },
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
                row.installedAppId === link.install.id &&
                row.name.toLowerCase() === link.player.toLowerCase()
        );
        if (!visit) continue;
        const install = link.install;
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

/** The most ended visits read to find the servers somebody played on lately:
 *  enough to cover several servers when one of them holds most of the visits. */
const MOST_ENDED_VISITS = 100;

/** One server somebody played on lately, as "Recent activity" draws it. */
export interface MinecraftPastVisit {
    readonly game: string;
    readonly server: string;
    readonly endedAt: Date;
    readonly installedAppId: string;
    readonly gameId: string;
    readonly imageUrl: string;
}

/**
 * The Minecraft servers here one account played on since `since`, newest
 * first, one entry per server: the last visit to each that has ended. Only the
 * links the account agrees with count, as for "playing now", and the read is
 * one indexed query bounded by `MOST_ENDED_VISITS`.
 */
export async function playedMinecraftRecently(
    userId: string,
    since: Date,
    limit: number
): Promise<MinecraftPastVisit[]> {
    if (limit <= 0) return [];
    const agreed = await agreedMinecraftLinks([userId]);
    if (agreed.length === 0) return [];
    const ended = await prisma.gamePlayerSession.findMany({
        where: {
            OR: agreed.map((link) => ({
                installedAppId: link.install.id,
                name: { equals: link.player, mode: "insensitive" as const }
            })),
            leftAt: { gte: since }
        },
        select: { installedAppId: true, leftAt: true },
        orderBy: { leftAt: "desc" },
        take: MOST_ENDED_VISITS
    });
    const installs = new Map(agreed.map((link) => [link.install.id, link.install]));
    const visits: MinecraftPastVisit[] = [];
    const seen = new Set<string>();
    for (const row of ended) {
        if (!row.leftAt || seen.has(row.installedAppId)) continue;
        const install = installs.get(row.installedAppId);
        if (!install) continue;
        seen.add(row.installedAppId);
        visits.push({
            game: gameOfServer(install.catalogId)?.name ?? "Minecraft",
            server: install.name,
            endedAt: row.leftAt,
            installedAppId: install.id,
            gameId: gameOfServer(install.catalogId)?.id ?? "minecraft",
            imageUrl: `/api/apps/installed/${install.id}/minecraft/card-icon`
        });
        if (visits.length >= limit) break;
    }
    return visits;
}

/**
 * The accounts with a player on a Minecraft server here right now: the open
 * visits, matched to the links on the same server. Every link counts, agreed or
 * not - this only narrows who a Chat message is looked at for, and the relay
 * applies its own rule to each. Bounded by who is on, never by the number of
 * accounts, so a channel message is not checked against everybody.
 */
export async function accountsPlayingMinecraftNow(): Promise<string[]> {
    const installs = await prisma.installedApp.findMany({
        where: { status: { not: "removed" } },
        select: { id: true, catalogId: true }
    });
    const minecraft = installs
        .filter((install) => gameOfServer(install.catalogId)?.id === "minecraft")
        .map((install) => install.id);
    if (minecraft.length === 0) return [];
    const on = await prisma.gamePlayerSession.findMany({
        where: { installedAppId: { in: minecraft }, leftAt: null },
        select: { installedAppId: true, name: true },
        take: MOST_PLAYING
    });
    if (on.length === 0) return [];
    const names = new Set(on.map((row) => `${row.installedAppId}:${row.name.toLowerCase()}`));
    const links = await prisma.gamePlayerLink.findMany({
        where: { installedAppId: { in: [...new Set(on.map((row) => row.installedAppId))] } },
        select: { installedAppId: true, player: true, userId: true }
    });
    return [
        ...new Set(
            links
                .filter((link) => names.has(`${link.installedAppId}:${link.player.toLowerCase()}`))
                .map((link) => link.userId)
        )
    ];
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
