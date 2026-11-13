/**
 * Telling somebody they were added to a server.
 *
 * Linking a player to an account is done by whoever runs the server; the person
 * linked would otherwise only find out by trying to join. A linked player who
 * does not manage the server cannot open its page, so the notice carries what
 * they need to join itself - the address, their player name and where they may
 * connect from - and points nowhere.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { ownerWords } from "../owner-words";

const { createNotification } = host.notificationService;

export const PLAYER_ADDED_EVENT = "games.player-added";

/** A repeat of the same link inside this window folds into the notice already
 *  on the bell, for the rare re-save that reaches here twice. */
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PlayerNotice {
    readonly ownerId: string;
    readonly installedAppId: string;
    readonly actorId: string;
    readonly userId: string;
    readonly player: string;
    readonly followSignIns: boolean;
    readonly bindAddresses: boolean;
}

/** The same server, account and player is the same notice. */
export function playerNoticeKey(installedAppId: string, userId: string, player: string): string {
    return `${PLAYER_ADDED_EVENT}:${installedAppId}:${userId}:${player.toLowerCase()}`;
}

/** Tell the linked account it was added. Never throws: the link is made either way. */
export async function tellLinkedPlayer(notice: PlayerNotice): Promise<boolean> {
    try {
        const [actor, server, typed, t] = await Promise.all([
            prisma.user.findUnique({
                where: { id: notice.actorId },
                select: { name: true, username: true }
            }),
            import("../games-service").then((games) =>
                games.gameServerFacts(notice.ownerId, notice.installedAppId)
            ),
            prisma.gamePlayerAccess.findMany({
                where: {
                    installedAppId: notice.installedAppId,
                    source: "manual",
                    username: { equals: notice.player, mode: "insensitive" }
                },
                select: { address: true },
                take: 20
            }),
            ownerWords(notice.userId, "games")
        ]);
        if (!server) return false;
        const who = actor?.name || actor?.username || t("notify.someone");
        const addresses = typed.map((row) => row.address);
        const where = notice.followSignIns
            ? t("notify.joinFromSignIns")
            : !notice.bindAddresses || addresses.includes("any")
              ? t("notify.joinFromAnywhere")
              : addresses.length > 0
                ? t("notify.joinFromAddresses", { addresses: addresses.join(", ") })
                : t("notify.joinFromAsk", { actor: who });
        const join = server.address
            ? t("notify.joinAt", { address: server.address, player: notice.player })
            : t("notify.joinAtAsk", { actor: who, player: notice.player });
        const outcome = await createNotification({
            userId: notice.userId,
            type: PLAYER_ADDED_EVENT,
            title: t("notify.playerAddedTitle", { actor: who, server: server.name }),
            body: `${join} ${where}`,
            level: "info",
            metadata: {
                installedAppId: notice.installedAppId,
                player: notice.player,
                address: server.address
            },
            dedupKey: playerNoticeKey(notice.installedAppId, notice.userId, notice.player),
            repeat: { windowMs: REPEAT_WINDOW_MS }
        });
        return outcome === "created";
    } catch (caught) {
        console.error("polaris: a player could not be told they were added:", caught);
        return false;
    }
}
