/**
 * Pinning a message for everybody in a conversation.
 *
 * Not the star. A star is one reader's bookmark (`messages.star`, `ChatStar`):
 * nobody else knows it is there, and it lives in their Starred list. A pin is the
 * room's: it sits above the conversation for everybody in it, it is announced in
 * the conversation the way WhatsApp and Discord both announce one, and only the
 * people allowed to change the room may set it - see `pinsAllowed`.
 *
 * From WhatsApp: a pin can be set to lapse - after a day, a week or a month -
 * and a lapsed pin is simply read as none, so nothing has to run to take it
 * down. From Discord: a pin can also stay until somebody takes it off, and the
 * conversation keeps a list of every pin in it, not only the newest few.
 */

import { prisma } from "@polaris/db";
import { ChatAccessError, pinsAllowed, requireChannel, type ChatActor } from "./access";
import { postNotice } from "./notices";
import { publishChatChange } from "./live";
import { decorateMessages, MESSAGE_SELECT, type ChatMessageView } from "./messages";
import { MAX_PINS, pinExpiry, type PinInput } from "./pin-rules";
import { requireAgeCleared } from "./age-gate";

export { MAX_PINS, PIN_DURATIONS, pinExpiry, pinInputSchema } from "./pin-rules";
export type { PinDuration, PinInput } from "./pin-rules";

/** The rows that are pinned at this moment: set, not lapsed, not deleted. */
function pinnedWhere(channelId: string, now: Date) {
    return {
        channelId,
        deletedAt: null,
        parentId: null,
        pinnedAt: { not: null },
        OR: [{ pinExpiresAt: null }, { pinExpiresAt: { gt: now } }]
    };
}

/** One pin as the conversation shows it. */
export interface ChatPinView {
    readonly message: ChatMessageView;
    readonly pinnedAt: string;
    /** Who pinned it, by their current name; null when the account is gone. */
    readonly pinnedBy: string | null;
    /** When it lapses, or null when it stays until unpinned. */
    readonly expiresAt: string | null;
}

/** Whether this reader may change the pins here, refused loudly when not. */
async function requirePinnable(actor: ChatActor, channelId: string): Promise<void> {
    const access = await requireChannel(actor, channelId);
    if (!access.mayPost) throw new ChatAccessError({ key: "errors.notAllowedHere" });
    const channel = await prisma.chatChannel.findUnique({
        where: { id: channelId },
        select: { kind: true, ownerId: true, createdById: true, membersMayEdit: true }
    });
    if (!channel || !pinsAllowed({ ...channel, mayModerate: access.mayModerate }, actor.id)) {
        throw new ChatAccessError({ key: "errors.pinNotAllowed" });
    }
}

/**
 * Pin a message for everybody, for as long as was asked. Pinning one that is
 * already pinned sets it again with the new length, which is how a lapsing pin
 * is made to stay.
 */
export async function pin(actor: ChatActor, input: PinInput): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: {
            channelId: true,
            kind: true,
            parentId: true,
            deletedAt: true,
            pinnedAt: true,
            pinExpiresAt: true
        }
    });
    if (!message || message.deletedAt) throw new ChatAccessError({ key: "errors.messageGone" });
    // A line Polaris wrote, or a reply inside a thread, is not something the
    // room pins: the bar above the conversation jumps to it, and a thread reply
    // is not in the conversation.
    if (message.kind === "system" || message.parentId) {
        throw new ChatAccessError({ key: "errors.pinNotAllowed" });
    }
    await requirePinnable(actor, message.channelId);

    const now = new Date();
    const already =
        message.pinnedAt !== null &&
        (message.pinExpiresAt === null || message.pinExpiresAt.getTime() > now.getTime());
    if (!already) {
        const count = await prisma.chatMessage.count({ where: pinnedWhere(message.channelId, now) });
        if (count >= MAX_PINS) {
            throw new ChatAccessError({ key: "errors.tooManyPins", params: { max: MAX_PINS } });
        }
    }

    await prisma.chatMessage.update({
        where: { id: input.messageId },
        data: {
            pinnedAt: now,
            pinnedById: actor.id,
            pinExpiresAt: pinExpiry(input.duration, now)
        }
    });
    publishChatChange({ channelId: message.channelId, kind: "pins", actorId: actor.id });
    // Said in the conversation, like both of the apps this copies. Only for a
    // new pin: lengthening one is not news.
    if (!already) await postNotice(message.channelId, "pinned", { subjectId: actor.id });
}

/** Take a pin off. Nothing happens to a message that was not pinned. */
export async function unpin(actor: ChatActor, messageId: string): Promise<void> {
    const message = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, pinnedAt: true }
    });
    if (!message) throw new ChatAccessError({ key: "errors.messageGone" });
    await requirePinnable(actor, message.channelId);
    if (message.pinnedAt === null) return;
    await prisma.chatMessage.update({
        where: { id: messageId },
        data: { pinnedAt: null, pinnedById: null, pinExpiresAt: null }
    });
    publishChatChange({ channelId: message.channelId, kind: "pins", actorId: actor.id });
}

/** Every pin in a conversation this reader can read, newest pin first. */
export async function pinsIn(actor: ChatActor, channelId: string): Promise<ChatPinView[]> {
    await requireChannel(actor, channelId);
    await requireAgeCleared(actor, channelId);
    const rows = await prisma.chatMessage.findMany({
        where: pinnedWhere(channelId, new Date()),
        orderBy: { pinnedAt: "desc" },
        take: MAX_PINS,
        select: { ...MESSAGE_SELECT, pinnedAt: true, pinnedById: true, pinExpiresAt: true }
    });
    if (rows.length === 0) return [];

    const views = new Map((await decorateMessages(actor, rows)).map((view) => [view.id, view]));
    const pinnerIds = [
        ...new Set(rows.map((row) => row.pinnedById).filter((id): id is string => id !== null))
    ];
    const pinners = new Map(
        (
            await prisma.user.findMany({
                where: { id: { in: pinnerIds } },
                select: { id: true, name: true }
            })
        ).map((person) => [person.id, person.name])
    );
    return rows.flatMap((row) => {
        const message = views.get(row.id);
        if (!message || !row.pinnedAt) return [];
        return [
            {
                message,
                pinnedAt: row.pinnedAt.toISOString(),
                pinnedBy: row.pinnedById ? (pinners.get(row.pinnedById) ?? null) : null,
                expiresAt: row.pinExpiresAt?.toISOString() ?? null
            }
        ];
    });
}
