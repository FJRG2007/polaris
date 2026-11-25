/**
 * Adding Polar to a conversation, and taking it out (docs/chat-e2ee-mls.md,
 * "Server-run members"). Polar is added the way a person is: by whoever may
 * add people there - whoever runs a channel, a group's owner or, where the
 * owner left it open, anybody in it.
 *
 * It matters only for a sealed conversation, where Polar reads nothing it was
 * not given: added, its device joins the conversation's group and opens what
 * is said there from then on; taken out, everything the server held for that
 * device is dropped, and the remover's device takes its leaf out of the group.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import { publishChatChange } from "./live";
import { sealedChatServed } from "./e2ee/flag";
import { addPolar, polarAdded, removePolar } from "./service-members";
import { ChatAccessError, invitesAllowed, requireChannel, type ChatActor } from "./access";

export interface PolarMembership {
    readonly added: boolean;
    /** Whether this reader may add or remove it. */
    readonly mayChange: boolean;
}

async function mayChangePolar(actor: ChatActor, channelId: string): Promise<boolean> {
    const access = await requireChannel(actor, channelId);
    if (access.archived) return false;
    if (access.mayAdminister) return true;
    if (access.kind !== "group") return false;
    // Asked of the row, as adding a person is (`addMembers`).
    const room = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { kind: true, spaceId: true, ownerId: true, createdById: true, membersMayInvite: true }
    });
    return room !== null && invitesAllowed({ ...room, mayAdminister: false }, actor.id);
}

/** Whether Polar is in this conversation, and whether this reader may change that. */
export async function polarMembership(actor: ChatActor, channelId: string): Promise<PolarMembership> {
    const [mayChange, added] = await Promise.all([mayChangePolar(actor, channelId), polarAdded(channelId)]);
    return { added, mayChange };
}

/** Add Polar to a conversation (`on`) or take it out; doing either twice is the same as once. */
export async function setPolarMember(actor: ChatActor, channelId: string, on: boolean): Promise<void> {
    if (!(await mayChangePolar(actor, channelId))) throw new ChatAccessError({ key: "errors.channelAddNotAllowed" });
    if (on) {
        await addPolar(actor.id, channelId);
        await joinSealedGroup(channelId);
    } else {
        await removePolar(channelId);
        if (sealedChatServed()) {
            const { forgetServiceDevice } = await import("./e2ee/service-device");
            await forgetServiceDevice("polar", channelId);
        }
    }
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}

/**
 * Open Polar's device once in a sealed conversation it was just added to, so
 * it registers and joins the group now rather than on the first question.
 * A failure is logged, not refused: the first question it is asked joins it.
 */
async function joinSealedGroup(channelId: string): Promise<void> {
    const sealed = await import("./e2ee/sealed-messages");
    if (!(await sealed.conversationSealed(channelId))) return;
    const { withServiceDevice } = await import("./e2ee/service-device");
    await withServiceDevice("polar", channelId, async (device) => void (await device.ensureGroup(channelId))).catch((error: unknown) =>
        console.error("chat: Polar could not join a sealed conversation:", error)
    );
}
