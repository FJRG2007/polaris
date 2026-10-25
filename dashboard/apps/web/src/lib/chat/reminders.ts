/**
 * Reminders on messages: "bring this back to me at three".
 *
 * Private to the person who sets one. Nothing about it is visible in the
 * conversation, and the only thing it ever does is put one line on that
 * person's bell, at the time they chose, that opens the message.
 *
 * Who may read the message is asked twice, the way a scheduled message asks
 * whether its writer may post: when the reminder is set AND when it fires.
 * The hours in between are when somebody leaves a room or is removed from it,
 * and a reminder that quoted a conversation they can no longer open would be a
 * way of reading it anyway. So a reminder whose reader lost the room fires
 * nothing at all; one whose message was deleted says so and quotes nothing.
 *
 * Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { chatWordsFor } from "./text";
import { chatAlertShelf } from "./isolation";
import * as history from "./history-visibility";
import { notify } from "@/lib/notifications/dispatch";
import { plainExcerpt } from "@/components/rich-text/excerpt";
import {
    ChatAccessError,
    channelAccess,
    reachableChannelIds,
    requireChannel,
    type ChatActor
} from "./access";

/** One waiting reminder, as the list draws it. */
export interface ChatReminderView {
    readonly id: string;
    readonly messageId: string;
    readonly channelId: string;
    readonly dueAt: string;
    /** What the message says, in one line. Empty for a deleted one. */
    readonly excerpt: string;
    readonly deleted: boolean;
}

/** Where a reminder opens: the conversation, at the message. */
export function reminderHref(channelId: string, messageId: string): string {
    return `/chat/c/${channelId}/${messageId}`;
}

/**
 * Set one, or move the one already on this message.
 *
 * Returns the moment it is set for, so the menu can say it back.
 */
export async function setReminder(
    actor: ChatActor,
    input: core.ChatReminderInput
): Promise<string> {
    const dueAt = new Date(input.dueAt);
    const problem = core.scheduleProblem(dueAt);
    if (problem) throw new ChatAccessError({ key: `errors.schedule.${problem}` });

    const message = await prisma.chatMessage.findUnique({
        where: { id: input.messageId },
        select: { channelId: true, deletedAt: true }
    });
    if (!message || message.deletedAt) throw new ChatAccessError({ key: "errors.messageGone" });
    await requireChannel(actor, message.channelId);
    await history.requireReadable(actor, message.channelId, input.messageId);

    const existing = await prisma.chatReminder.findUnique({
        where: { userId_messageId: { userId: actor.id, messageId: input.messageId } },
        select: { firedAt: true }
    });
    // Moving one that is already waiting adds nothing to the count.
    if (!existing || existing.firedAt) {
        const pending = await prisma.chatReminder.count({
            where: { userId: actor.id, firedAt: null }
        });
        if (pending >= core.MAX_PENDING_REMINDERS) {
            throw new ChatAccessError({
                key: "errors.tooManyReminders",
                params: { max: core.MAX_PENDING_REMINDERS }
            });
        }
    }

    await prisma.chatReminder.upsert({
        where: { userId_messageId: { userId: actor.id, messageId: input.messageId } },
        create: { userId: actor.id, messageId: input.messageId, dueAt },
        update: { dueAt, firedAt: null }
    });
    return dueAt.toISOString();
}

/**
 * Everything this person has waiting, soonest first.
 *
 * Re-checked against the rooms on the way out, like the saved list: a reminder
 * in a room they have since left stays a row until it fires (and fires
 * nothing), but it is not listed, because listing it would quote the room.
 */
export async function listReminders(actor: ChatActor): Promise<ChatReminderView[]> {
    const rows = await prisma.chatReminder.findMany({
        where: { userId: actor.id, firedAt: null },
        orderBy: { dueAt: "asc" },
        take: core.MAX_PENDING_REMINDERS,
        select: {
            id: true,
            messageId: true,
            dueAt: true,
            message: {
                select: { channelId: true, body: true, deletedAt: true, createdAt: true }
            }
        }
    });
    if (rows.length === 0) return [];

    const reachable = await reachableChannelIds(actor);
    const visible = rows.filter((row) => reachable.has(row.message.channelId));
    // One floor per room rather than one question per reminder.
    const floors = new Map<string, Date | null>();
    for (const channelId of new Set(visible.map((row) => row.message.channelId))) {
        floors.set(channelId, await history.readableSince(actor, channelId));
    }
    return visible
        .filter((row) =>
            history.isReadable(floors.get(row.message.channelId), row.message.createdAt)
        )
        .map((row) => ({
            id: row.id,
            messageId: row.messageId,
            channelId: row.message.channelId,
            dueAt: row.dueAt.toISOString(),
            excerpt: row.message.deletedAt ? "" : plainExcerpt(row.message.body),
            deleted: row.message.deletedAt !== null
        }));
}

/** Take one back. Silent for one that is not theirs or is already gone - both
 *  are "nothing waiting under that id". */
export async function cancelReminder(actor: ChatActor, id: string): Promise<void> {
    await prisma.chatReminder.deleteMany({ where: { id, userId: actor.id, firedAt: null } });
}

/** How many fire in one pass. Whatever is left is due a minute later. */
const PER_PASS = 200;

/** How long a fired row is kept before the sweep removes it. Long enough that a
 *  pass running twice finds it claimed; nothing reads it after that. */
const FIRED_KEPT_MS = 24 * 60 * 60 * 1000;

/** What one due reminder came to. */
export type ReminderOutcome = "sent" | "deleted" | "unreadable" | "claimed";

/**
 * Fire everything that has come due.
 *
 * Each row is claimed before anything is sent - `firedAt` is set only where it
 * is still null - so two passes over the same minute, or a lease lost halfway,
 * send it once. A notification that fails after the claim is not retried: a
 * reminder twice is worse than a reminder late, and the bell's own write is
 * best-effort everywhere else too.
 */
export async function sweepDueReminders(
    now: Date = new Date()
): Promise<Record<ReminderOutcome, number>> {
    await prisma.chatReminder.deleteMany({
        where: { firedAt: { lt: new Date(now.getTime() - FIRED_KEPT_MS) } }
    });

    const due = await prisma.chatReminder.findMany({
        where: { firedAt: null, dueAt: { lte: now } },
        orderBy: { dueAt: "asc" },
        take: PER_PASS,
        select: { id: true, userId: true, messageId: true }
    });

    const counts: Record<ReminderOutcome, number> = {
        sent: 0,
        deleted: 0,
        unreadable: 0,
        claimed: 0
    };
    for (const row of due) {
        try {
            counts[await fire(row, now)] += 1;
        } catch (caught) {
            console.error("chat reminder:", caught);
        }
    }
    return counts;
}

/** Claim one, then say it - or say nothing, when the room is no longer theirs. */
async function fire(
    row: { id: string; userId: string; messageId: string },
    now: Date
): Promise<ReminderOutcome> {
    const claim = await prisma.chatReminder.updateMany({
        where: { id: row.id, firedAt: null },
        data: { firedAt: now }
    });
    if (claim.count === 0) return "claimed";

    const message = await prisma.chatMessage.findUnique({
        where: { id: row.messageId },
        select: {
            channelId: true,
            body: true,
            deletedAt: true,
            channel: { select: { orgId: true, space: { select: { orgId: true } } } }
        }
    });
    if (!message) return "unreadable";

    const actor = { id: row.userId };
    if (!(await channelAccess(actor, message.channelId))) return "unreadable";
    try {
        await history.requireReadable(actor, message.channelId, row.messageId);
    } catch {
        return "unreadable";
    }

    const words = await chatWordsFor(row.userId);
    const shelf = await chatAlertShelf(message.channel);
    if (message.deletedAt) {
        await notify({
            userId: row.userId,
            event: "chat.reminder",
            title: words("notices.reminderDeleted"),
            href: `/chat/c/${message.channelId}`,
            shelf
        });
        return "deleted";
    }
    await notify({
        userId: row.userId,
        event: "chat.reminder",
        title: words("notices.reminder"),
        body: plainExcerpt(message.body) || null,
        href: reminderHref(message.channelId, row.messageId),
        shelf
    });
    return "sent";
}
