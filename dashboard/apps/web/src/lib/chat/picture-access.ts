import { prisma } from "@polaris/db";
import { channelAccess, picturesAllowed, spaceAccess } from "@/lib/chat/access";

/**
 * Who may change the picture on a space or a conversation.
 *
 * A space: its owner, or somebody who administers it. A channel inside one: the
 * same people. A group message has no administrators at all - everybody in one
 * is equal in it - so the answer there is the person who started it, which is
 * what the ask was and what every messenger does.
 *
 * Shared by the upload route and the GIF action, so the two ways of setting a
 * picture cannot drift apart on who is allowed to.
 */
export async function mayChangeChatPicture(
    userId: string,
    kind: "space" | "channel",
    id: string
): Promise<boolean> {
    const actor = { id: userId };
    if (kind === "space") {
        const access = await spaceAccess(actor, id);
        return access === "owner" || access === "admin";
    }

    const access = await channelAccess(actor, id);
    if (!access) return false;

    const channel = await prisma.chatChannel.findUnique({
        where: { id },
        select: { kind: true, ownerId: true, membersMayEdit: true }
    });
    if (!channel) return false;
    return picturesAllowed({ ...channel, mayAdminister: access.mayAdminister }, userId);
}
