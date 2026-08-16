/**
 * Saying out loud that somebody came or went.
 *
 * Every messenger does this and it is not decoration: a group that gains a
 * person silently is a group where the next message is read by somebody nobody
 * knows is there, and one that loses a person silently is a group where a
 * question is asked of somebody who left last week. The line is the only record
 * of it - membership itself keeps no history.
 *
 * Four decisions worth stating, because each has an obvious-looking alternative:
 *
 * **A notice is a message, not a notification.** It is written into the
 * conversation as a `system` message with no author, so it is read where it
 * happened, by whoever opens the room, in the order it happened in. Nothing is
 * pushed to anybody's bell.
 *
 * **It does not move the conversation or light the badge.** `lastMessageAt` is
 * left alone and the unread count skips system messages, so a room does not
 * jump to the top of everybody's list because somebody walked in. A badge that
 * counts events nobody said is a badge people stop trusting.
 *
 * **It never fails the thing it is about.** Joining, leaving and being added
 * are membership writes that have already happened by the time this runs; a
 * notice that threw would turn a completed change into an error message. So
 * everything here is best effort and swallows its own failures.
 *
 * **Leaving can be done quietly.** Walking out of a room is not an announcement
 * somebody owes the room, so the confirmation offers to skip it - which is a
 * decision the person leaving makes and nobody else can make for them. Joining
 * has no such switch: being in a room is not a thing that can be kept from the
 * people already in it.
 */

import { prisma } from "@polaris/db";
import { publishChatChange } from "./live";
import { noticeBody, type ChatNoticeKind, type NoticePerson } from "./notice-text";

/** Who a notice is about and, when somebody else did it, who that was. */
interface NoticeCast {
    readonly subjectId: string;
    readonly byId?: string | null;
}

/** The names to write into the row, which are only a fallback - the reader
 *  resolves them again. Somebody unfindable still gets a line, because the
 *  membership change happened whether or not the account is still readable. */
async function cast(ids: readonly string[]): Promise<Map<string, NoticePerson>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) return new Map();
    const people = await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true, name: true }
    });
    return new Map(people.map((person) => [person.id, { id: person.id, name: person.name }]));
}

/**
 * Write one into a conversation.
 *
 * @returns Nothing, and never throws.
 */
export async function postNotice(
    channelId: string,
    kind: ChatNoticeKind,
    { subjectId, byId = null }: NoticeCast
): Promise<void> {
    try {
        const people = await cast([subjectId, ...(byId ? [byId] : [])]);
        const subject = people.get(subjectId) ?? { id: subjectId, name: "Somebody" };
        const by = byId && byId !== subjectId ? (people.get(byId) ?? null) : null;

        await prisma.chatMessage.create({
            data: { channelId, kind: "system", authorId: null, body: noticeBody(kind, subject, by) }
        });
        publishChatChange({ channelId, kind: "posted", actorId: byId ?? subjectId });
    } catch {
        // The membership change stands either way. A conversation that is one
        // line short of complete is a far better outcome than a join that
        // reports itself as having failed.
    }
}

/**
 * Where a space says these things.
 *
 * A space is not a conversation, so a join has to land in one of its rooms, and
 * the one it lands in is the first open text channel - which is the room a
 * space is read in and the one a newcomer opens. A private channel is never
 * picked: it is a room chosen people are in, and a notice about the space would
 * be visible to that handful and nobody else.
 *
 * Null when a space has no such room, and then nothing is written. That is the
 * honest answer: there is nowhere for it to be read.
 */
export async function spaceNoticeChannel(spaceId: string): Promise<string | null> {
    const channel = await prisma.chatChannel.findFirst({
        where: { spaceId, kind: "text", private: false, archived: false },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: { id: true }
    });
    return channel?.id ?? null;
}

/** The same, for something that happened to a space rather than to one room. */
export async function postSpaceNotice(
    spaceId: string,
    kind: ChatNoticeKind,
    people: NoticeCast
): Promise<void> {
    try {
        const channelId = await spaceNoticeChannel(spaceId);
        if (!channelId) return;
        await postNotice(channelId, kind, people);
    } catch {
        // As above: never at the cost of the membership change.
    }
}
