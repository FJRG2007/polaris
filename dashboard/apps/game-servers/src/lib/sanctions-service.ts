/**
 * Writing down the bans, timeouts and kicks put on a game server's players, and
 * reading back the ones against the players linked to one account.
 *
 * The game's own ban list is no help here: it forgets why and when, a timeout's
 * end lives in the install's settings until it is swept away, and a kick leaves
 * no trace at all. So each is written where it is applied, and the account's
 * Account standing page reads them through the app extension registry.
 *
 * Writing never fails the action it records: the player is already banned, and
 * a note that could not be kept must not turn that into an error on screen.
 */

import { prisma } from "@polaris/db";
import { gameOfServer } from "@polaris/core";
import { accountAgrees, connectedMinecraftNames } from "./link-agreement";
import {
    SANCTION_HISTORY_DAYS,
    sanctionActive,
    shownOnStanding,
    type SanctionKind,
    type StandingSanction
} from "./sanctions";

/** The most a standing page lists: a page, not an archive. */
const MAX_LISTED = 100;

/**
 * Note a sanction just applied. A new ban or timeout replaces whatever ban or
 * timeout the player was under, as it does in the game.
 */
export async function recordSanction(entry: {
    readonly installedAppId: string;
    readonly player: string;
    readonly kind: SanctionKind;
    readonly reason?: string | null;
    readonly until?: Date | null;
}): Promise<void> {
    const player = entry.player.toLowerCase();
    const reason = entry.reason && entry.reason.trim().length > 0 ? entry.reason.trim() : null;
    try {
        if (entry.kind !== "kick") await liftOpen(entry.installedAppId, player);
        await prisma.gameSanction.create({
            data: {
                installedAppId: entry.installedAppId,
                player,
                kind: entry.kind,
                reason,
                until: entry.until ?? null
            }
        });
    } catch (caught) {
        console.error("polaris: a game sanction could not be recorded:", caught);
    }
}

/** The player was pardoned, or their timeout lifted early. */
export async function liftSanctions(installedAppId: string, player: string): Promise<void> {
    await liftOpen(installedAppId, player.toLowerCase()).catch((caught: unknown) => {
        console.error("polaris: a game sanction could not be lifted:", caught);
    });
}

async function liftOpen(installedAppId: string, player: string): Promise<void> {
    await prisma.gameSanction.updateMany({
        where: { installedAppId, player, kind: { in: ["ban", "timeout"] }, liftedAt: null },
        data: { liftedAt: new Date() }
    });
}

/** Everything kept about a server that no longer exists. */
export async function clearSanctions(installedAppId: string): Promise<void> {
    await prisma.gameSanction.deleteMany({ where: { installedAppId } }).catch(() => undefined);
}

/**
 * The sanctions on every player linked to this account, on servers that still
 * exist: those in force, and the rest from the last few months. In force first,
 * then newest first. Only links the account agrees with count
 * (`link-agreement`): a player linked to it by mistake is somebody else, and
 * their sanctions and the reasons for them are theirs.
 */
export async function sanctionsForUser(
    userId: string,
    now: Date = new Date()
): Promise<StandingSanction[]> {
    const links = await prisma.gamePlayerLink.findMany({
        where: { userId },
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
        connectedMinecraftNames([userId])
    ]);
    const servers = new Map(
        installs.flatMap((install) => {
            const game = gameOfServer(install.catalogId);
            return game
                ? [
                      [
                          install.id,
                          {
                              game: game.name,
                              server: install.name,
                              ownerId: install.ownerId,
                              minecraft: game.id === "minecraft"
                          }
                      ] as const
                  ]
                : [];
        })
    );
    const linked = links.filter((link) => {
        const server = servers.get(link.installedAppId);
        return server ? accountAgrees(link, server, ownNames) : false;
    });
    if (linked.length === 0) return [];

    const since = new Date(now.getTime() - SANCTION_HISTORY_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.gameSanction.findMany({
        where: {
            OR: linked.map((link) => ({
                installedAppId: link.installedAppId,
                player: link.player.toLowerCase()
            })),
            AND: [{ OR: [{ at: { gte: since } }, { liftedAt: null, kind: { not: "kick" } }] }]
        },
        orderBy: { at: "desc" },
        take: MAX_LISTED,
        select: {
            id: true,
            installedAppId: true,
            player: true,
            kind: true,
            reason: true,
            at: true,
            until: true,
            liftedAt: true
        }
    });

    const names = new Map(
        linked.map((link) => [`${link.installedAppId}:${link.player.toLowerCase()}`, link.player])
    );
    const listed: StandingSanction[] = [];
    for (const row of rows) {
        const where = servers.get(row.installedAppId);
        if (!where || !shownOnStanding(row, now)) continue;
        listed.push({
            id: row.id,
            kind: row.kind as SanctionKind,
            game: where.game,
            server: where.server,
            player: names.get(`${row.installedAppId}:${row.player}`) ?? row.player,
            at: row.at,
            until: row.until,
            active: sanctionActive(row, now),
            reason: row.reason
        });
    }
    return listed.sort(
        (left, right) =>
            Number(right.active) - Number(left.active) || right.at.getTime() - left.at.getTime()
    );
}
