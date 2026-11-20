/**
 * Telling somebody they were added to a server.
 *
 * Linking a player to an account is done by whoever runs the server; the person
 * linked would otherwise only find out by trying to join. They are told in a
 * direct message from whoever added them, drawn as the server's invite card -
 * the address, their player name and where they may connect from. Only when
 * that message cannot be sent (they take no messages from that person, Chat is
 * not reachable) does a line in their bell say the same thing instead. One path
 * for every game whose players are linked here.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";
import { ownerWords } from "../owner-words";

const { createNotification } = host.notificationService;
const { sendGamePlayerInvite } = host.chatGameInvites;
const { readInstallConfig } = host.appsInstallConfig;

export const PLAYER_ADDED_EVENT = "games.player-added";

/** A repeat of the same link inside this window folds into the notice already
 *  on the bell, for the rare re-save that reaches here twice. */
const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Where the person heard about it: their Chat, their bell, or nowhere. */
export type PlayerToldIn = "chat" | "notification" | null;

/** Where an invited player may connect from. */
export type JoinFrom =
    | { readonly kind: "signIns" }
    | { readonly kind: "anywhere" }
    | { readonly kind: "addresses"; readonly addresses: readonly string[] }
    | { readonly kind: "ask" };

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

/** Where a player may connect from, from how they are held. */
export function joinFromOf(input: {
    readonly followSignIns: boolean;
    readonly bindAddresses: boolean;
    readonly addresses: readonly string[];
}): JoinFrom {
    if (input.followSignIns) return { kind: "signIns" };
    if (!input.bindAddresses || input.addresses.includes("any")) return { kind: "anywhere" };
    if (input.addresses.length > 0) return { kind: "addresses", addresses: input.addresses };
    return { kind: "ask" };
}

/** The addresses typed for one player on a server. */
async function typedAddresses(installedAppId: string, player: string): Promise<string[]> {
    const rows = await prisma.gamePlayerAccess.findMany({
        where: {
            installedAppId,
            source: "manual",
            username: { equals: player, mode: "insensitive" }
        },
        select: { address: true },
        take: 20
    });
    return rows.map((row) => row.address);
}

/** Where a player may connect to a server from right now, for their invite
 *  card. Null when the server is not one of this owner's. */
export async function joinFromFor(
    ownerId: string,
    installedAppId: string,
    player: string
): Promise<JoinFrom | null> {
    const [install, link, addresses] = await Promise.all([
        prisma.installedApp.findFirst({
            where: { id: installedAppId, ownerId, status: { not: "removed" } },
            select: { config: true }
        }),
        prisma.gamePlayerLink.findFirst({
            where: { installedAppId, player: { equals: player, mode: "insensitive" } },
            select: { followSignIns: true }
        }),
        typedAddresses(installedAppId, player)
    ]);
    if (!install) return null;
    return joinFromOf({
        followSignIns: link?.followSignIns ?? false,
        // Absent means on, as everywhere else the setting is read.
        bindAddresses: readInstallConfig(install.config).bindAddresses !== false,
        addresses
    });
}

/** Tell the linked account it was added: in Chat, or in their bell when Chat
 *  cannot reach them. Never throws: the link is made either way. */
export async function tellLinkedPlayer(notice: PlayerNotice): Promise<PlayerToldIn> {
    try {
        const [actor, server, addresses, t] = await Promise.all([
            prisma.user.findUnique({
                where: { id: notice.actorId },
                select: { name: true, username: true }
            }),
            import("../games-service").then((games) =>
                games.gameServerFacts(notice.ownerId, notice.installedAppId)
            ),
            typedAddresses(notice.installedAppId, notice.player),
            ownerWords(notice.userId, "games")
        ]);
        if (!server) return null;
        const who = actor?.name || actor?.username || t("notify.someone");
        const from = joinFromOf({
            followSignIns: notice.followSignIns,
            bindAddresses: notice.bindAddresses,
            addresses
        });
        const where =
            from.kind === "signIns"
                ? t("notify.joinFromSignIns")
                : from.kind === "anywhere"
                  ? t("notify.joinFromAnywhere")
                  : from.kind === "addresses"
                    ? t("notify.joinFromAddresses", { addresses: from.addresses.join(", ") })
                    : t("notify.joinFromAsk", { actor: who });
        const join = server.address
            ? t("notify.joinAt", { address: server.address, player: notice.player })
            : t("notify.joinAtAsk", { actor: who, player: notice.player });
        const title = t("notify.playerAddedTitle", { actor: who, server: server.name });
        const sent = await sendGamePlayerInvite({
            inviterId: notice.actorId,
            targetId: notice.userId,
            installedAppId: notice.installedAppId,
            player: notice.player,
            fallback: `${title}. ${join} ${where}`
        }).catch(() => null);
        if (sent === "chat") return "chat";
        const outcome = await createNotification({
            userId: notice.userId,
            type: PLAYER_ADDED_EVENT,
            title,
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
        return outcome === "created" ? "notification" : null;
    } catch (caught) {
        console.error("polaris: a player could not be told they were added:", caught);
        return null;
    }
}
