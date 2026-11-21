/**
 * Advanced chat privacy: a per-conversation switch that keeps what is said in
 * it inside it.
 *
 * Prior art: WhatsApp's "Advanced Chat Privacy" (2025). With it on, nobody can
 * hand the conversation's history to Polar or an app command, nobody can
 * download its files as files (they are still shown in the chat), and nothing
 * in it can be forwarded. Every one of those is refused here, on the server;
 * the screen only follows.
 *
 * It binds what Polaris serves. A browser that is shown a picture can still
 * keep it, and it is described to readers that way.
 *
 * Who may turn it on or off: anybody in a direct message or a group, which is
 * how WhatsApp does it, and whoever runs a space channel. Each change writes a
 * line into the conversation, so nobody's privacy changes behind their back.
 */

import { prisma } from "@polaris/db";
import { publishChatChange } from "./live";
import { postNoticeBody } from "./notices";
import { noticeMention } from "./notice-text";
import { ChatAccessError, requireChannel, type ChatActor } from "./access";

/** Which of these conversations have it on, in one read. */
export async function shieldedAmong(channelIds: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(channelIds)];
    if (wanted.length === 0) return new Set();
    const rows = await prisma.chatChannel.findMany({
        where: { id: { in: wanted }, advancedPrivacy: true },
        select: { id: true }
    });
    return new Set(rows.map((row) => row.id));
}

/** Whether one conversation has it on. Unknown is off, which is what every
 *  conversation was before the switch existed. */
export async function isShielded(channelId: string): Promise<boolean> {
    return (await shieldedAmong([channelId])).has(channelId);
}

/** Turn it on or off. A no-op when it is already that way. */
export async function setAdvancedPrivacy(
    actor: ChatActor,
    channelId: string,
    on: boolean
): Promise<void> {
    const access = await requireChannel(actor, channelId);
    // A space channel is run by its administrators; anywhere else every member
    // decides, the same as WhatsApp.
    if (access.spaceId ? !access.mayAdminister : !access.member) {
        throw new ChatAccessError({ key: "errors.channelChangeNotAllowed" });
    }
    if (access.archived) throw new ChatAccessError({ key: "errors.conversationArchived" });
    const changed = await prisma.chatChannel.updateMany({
        where: { id: channelId, advancedPrivacy: !on },
        data: { advancedPrivacy: on }
    });
    if (changed.count === 0) return;
    const user = await prisma.user.findUnique({ where: { id: actor.id }, select: { name: true } });
    const who = noticeMention({ id: actor.id, name: user?.name ?? "Somebody" });
    await postNoticeBody(
        channelId,
        on
            ? `${who} turned on advanced chat privacy: no Polar or app commands over this chat, no downloads and no forwarding`
            : `${who} turned off advanced chat privacy`,
        actor.id
    );
    publishChatChange({ channelId, kind: "channels", actorId: actor.id });
}
