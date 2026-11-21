"use server";

/**
 * What the game server card in a conversation shows this reader. Read against
 * the reader's own standing on the server, never the sharer's: somebody whose
 * access ended sees that it did, and not the address.
 */

import { z } from "zod";
import { requireUser } from "@/lib/session";
import * as card from "@/lib/chat/game-server-card";
import { gameServerAccess } from "@/lib/apps/install-access";
import { prisma } from "@polaris/db";
import { gameServerCardFacts, gamePlayerJoinFrom } from "@/lib/app-extensions/registry";

export async function readGameServerCard(
    installedAppId: unknown
): Promise<card.GameServerCardView | null> {
    const id = z.string().uuid().safeParse(installedAppId);
    if (!id.success) return null;
    const user = await requireUser();
    const access = await gameServerAccess(user, id.data, "games.read").catch(() => null);
    if (!access) return { state: "denied" };
    const facts = await gameServerCardFacts(access.ownerId, id.data);
    if (!facts) return { state: "denied" };
    return card.cardView(facts);
}

const inviteSchema = z.object({
    installedAppId: z.string().uuid(),
    player: z.string().min(1).max(64)
});

/** The server an invite names, when this reader holds the player it invites:
 *  a link from that player to their account. */
async function linkedOwner(userId: string, installedAppId: string, player: string) {
    const link = await prisma.gamePlayerLink.findFirst({
        where: { installedAppId, userId, player: { equals: player, mode: "insensitive" } },
        select: { id: true }
    });
    if (!link) return null;
    const install = await prisma.installedApp.findFirst({
        where: { id: installedAppId, status: { not: "removed" } },
        select: { ownerId: true }
    });
    return install?.ownerId ?? null;
}

/**
 * What an invite card shows this reader. Somebody who may read the server sees
 * it with a way to its page; the player it invites sees it without one, because
 * being let onto a server is not being let into its page. Anybody else - the
 * player once unlinked, a forwarded copy - is told only that it is not theirs.
 * Whether this reader is the invited player decides who the card speaks to.
 */
export async function readGameInviteCard(
    installedAppId: unknown,
    player: unknown
): Promise<card.GameInviteCardView | null> {
    const parsed = inviteSchema.safeParse({ installedAppId, player });
    if (!parsed.success) return null;
    const { installedAppId: id, player: name } = parsed.data;
    const user = await requireUser();
    const [access, linked] = await Promise.all([
        gameServerAccess(user, id, "games.read").catch(() => null),
        linkedOwner(user.id, id, name)
    ]);
    const ownerId = access?.ownerId ?? linked;
    if (!ownerId) return { state: "denied" };
    const [facts, joinFrom] = await Promise.all([
        gameServerCardFacts(ownerId, id),
        gamePlayerJoinFrom(ownerId, id, name).catch(() => null)
    ]);
    if (!facts) return { state: "denied" };
    const view = card.cardView(facts);
    if (view.state !== "ready") return { state: "denied" };
    return { ...view, player: name, joinFrom, canOpen: Boolean(access), forPlayer: linked !== null };
}
