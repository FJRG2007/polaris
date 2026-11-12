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
    kind: "space" | "channel" | "webhook",
    id: string
): Promise<boolean> {
    const actor = { id: userId };
    if (kind === "webhook") {
        // Whoever manages the channel's webhooks - the same standing as
        // renaming one.
        const hook = await prisma.chatWebhook.findUnique({
            where: { id },
            select: { channelId: true }
        });
        if (!hook) return false;
        const access = await channelAccess(actor, hook.channelId);
        return Boolean(access?.spaceId && access.mayAdminister);
    }
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
