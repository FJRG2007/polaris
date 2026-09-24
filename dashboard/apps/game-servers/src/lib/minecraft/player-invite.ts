/**
 * The other end of inviting a player: their account exists now, so tie it to
 * the name they play under.
 *
 * Reached from core only through the extension's `claimLink`, after the invite
 * service has checked the inviter still manages the server. The server may have
 * been deleted since the invite went out, which is nothing to link.
 */

import { prisma } from "@polaris/db";
import { linkPlayerAccount } from "./player-access";

export async function claimPlayerInvite(input: {
    userId: string;
    installedAppId: string;
    grantedById: string;
    player: string;
    followSignIns: boolean;
}): Promise<void> {
    const install = await prisma.installedApp.findUnique({
        where: { id: input.installedAppId },
        select: { ownerId: true }
    });
    if (!install) return;
    await linkPlayerAccount(install.ownerId, input.installedAppId, input.grantedById, {
        username: input.player,
        userId: input.userId,
        followSignIns: input.followSignIns
    });
}
