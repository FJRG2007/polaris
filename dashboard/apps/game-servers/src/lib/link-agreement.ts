/**
 * Whether an account agrees with a link an operator made between it and a
 * player on a game server.
 *
 * A link is the operator's word. It counts toward what the account itself is
 * shown or shows others - where it is playing, the sanctions on it and why -
 * only where the account agrees with it: the server is the account's own, the
 * player is the Minecraft account it connected, or the link follows the
 * account's sign-ins (whose addresses the join guard already enforces). A link
 * made by mistake to somebody else's player must not show one person another's
 * whereabouts, bans or reasons.
 */

import { prisma } from "@polaris/db";

export interface AgreedLink {
    readonly userId: string;
    readonly player: string;
    readonly followSignIns: boolean;
}

/** The Minecraft names each of these accounts connected, as `userId:name`. */
export async function connectedMinecraftNames(userIds: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return new Set();
    const connected = await prisma.userConnection.findMany({
        where: { userId: { in: wanted }, provider: "minecraft" },
        select: { userId: true, label: true }
    });
    return new Set(connected.map((one) => `${one.userId}:${one.label.toLowerCase()}`));
}

export function accountAgrees(
    link: AgreedLink,
    server: { readonly ownerId: string; readonly minecraft: boolean },
    minecraftNames: ReadonlySet<string>
): boolean {
    return (
        server.ownerId === link.userId ||
        link.followSignIns ||
        (server.minecraft && minecraftNames.has(`${link.userId}:${link.player.toLowerCase()}`))
    );
}
