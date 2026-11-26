/**
 * Whether a conversation is sealed, on its own so the plain message paths
 * (`lib/chat/messages`, `lib/chat/scheduled`) can ask it without importing the
 * sealed store, which imports them.
 *
 * A sealed conversation takes only sealed writes (docs/chat-e2ee-mls.md, "Sealed
 * only"): once its MLS group exists, a body in the clear - an older desktop or
 * extension build, the API, a message kind that has no sealed form yet - is
 * refused rather than stored beside the ciphertext for the server to read.
 */

import { prisma } from "@polaris/db";
import { sealedChatServed } from "./flag";

/**
 * Whether a conversation is sealed: sealed chat is on, and its MLS group exists
 * or the migration cut it (its history sealed, `legacy-migration.ts`) - a cut
 * conversation is sealed only before any browser has made its group.
 */
export async function conversationSealed(channelId: string): Promise<boolean> {
    if (!sealedChatServed()) return false;
    const [group, cut] = await Promise.all([
        prisma.mlsGroup.count({ where: { channelId }, take: 1 }),
        prisma.chatMigration.count({ where: { channelId, state: "cut" }, take: 1 })
    ]);
    return group + cut > 0;
}

/** Which of these conversations are sealed (`conversationSealed`), in two queries for the lot. */
export async function sealedConversations(channelIds: readonly string[]): Promise<Set<string>> {
    const ids = [...new Set(channelIds)];
    if (!ids.length || !sealedChatServed()) return new Set();
    const [groups, cuts] = await Promise.all([
        prisma.mlsGroup.findMany({ where: { channelId: { in: ids } }, select: { channelId: true } }),
        prisma.chatMigration.findMany({ where: { channelId: { in: ids }, state: "cut" }, select: { channelId: true } })
    ]);
    return new Set([...groups, ...cuts].map((row) => row.channelId));
}
