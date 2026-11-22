/**
 * What the conversation with yourself is called, for its own reader: their
 * name with a "(you)" marker in their language - the label the rail draws,
 * used wherever else the room's name is shown (header, references, search).
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { chatWordsFor } from "./text";

export async function selfConversationName(userId: string): Promise<string> {
    const [words, me] = await Promise.all([
        chatWordsFor(userId),
        prisma.user.findUnique({ where: { id: userId }, select: { name: true, username: true } })
    ]);
    const name = me?.name || (me?.username ? `@${me.username}` : "");
    return words("sidebar.selfName", { name });
}
