/**
 * The entries the app menu lists under its grid, and clearing their badges.
 *
 * Every group is asked the same question its badge asks - the same shelf, the
 * same mutes, the same folders, the same badge mark - so the group's total is
 * the badge's number. Marking an app read from the menu clears its badge and
 * nothing inside it, the way a phone's launcher does: see `launcher-waiting`.
 *
 * Bounded on purpose: a group lists the newest few, read with a grouped query,
 * and "mark all read" in Mail takes the unread mail in batches rather than one
 * list of every id somebody has never opened.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { onShelf } from "@/lib/mailbox/access";
import { addressesFrom } from "@/lib/mailbox/json";
import { mailShelfFor } from "@/lib/mailbox/shelf";
import { actOnMessages } from "@/lib/mailbox/messages";
import { publishMail } from "@/lib/mailbox/live";
import { publishChatChange } from "@/lib/chat/live";
import { readNoticesAboutThreads } from "@/lib/mailbox/mail-notices";
import { badgeClearedAt, clearAppBadge } from "@/lib/badge-seen";
import { markChannelsRead } from "@/lib/chat/messages";
import { adminWaiting, dismissAdminWaiting } from "@/lib/admin-waiting";
import { listChannels, unreadConversations } from "@/lib/chat/chat-service";
import {
    ADMIN_ITEM_IDS,
    clipText,
    DISMISSABLE_ADMIN_ITEMS,
    LAUNCHER_ITEMS_PER_APP,
    type AdminItemId,
    type LauncherWaitingApp,
    type LauncherWaitingGroup,
    type LauncherWaitingItem
} from "@/lib/launcher-waiting";

/** What one account may see entries for: each app's own gate, decided by the
 *  caller from the same checks the badges use. */
export interface LauncherReach {
    readonly chat: boolean;
    readonly mail: boolean;
    readonly admin: boolean;
}

/** How many unread messages one conversation's "mark read" takes. */
const MAIL_BATCH = 500;

/** How many conversations' bell notices one badge clear takes with it. */
const MAIL_NOTICE_THREADS = 2000;

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/** The conversations with something unread, as the badge counts them (see
 *  `unreadTotal`), newest first. */
async function newestUnread(userId: string) {
    const unread = await unreadConversations({ id: userId });
    return unread.sort(
        (left, right) =>
            (right.lastMessageAt?.getTime() ?? 0) - (left.lastMessageAt?.getTime() ?? 0)
    );
}

async function chatGroup(userId: string): Promise<LauncherWaitingGroup | null> {
    const unread = await newestUnread(userId);
    if (unread.length === 0) return null;
    const shown = unread.slice(0, LAUNCHER_ITEMS_PER_APP);
    // Named the way the rail names them - a direct message after who is in it -
    // for the few listed, not the whole rail.
    const named = new Map(
        (
            await listChannels(
                { id: userId },
                shown.map((channel) => channel.id)
            )
        ).map((channel) => [channel.id, channel.name])
    );
    return {
        app: "chat",
        total: unread.reduce((sum, channel) => sum + channel.unread, 0),
        items: shown.flatMap((channel) => {
            const name = named.get(channel.id);
            if (name === undefined) return [];
            return [
                {
                    id: channel.id,
                    title: clipText(name),
                    detail: "",
                    href: `/chat/c/${channel.id}`,
                    count: channel.unread,
                    dismissable: true
                }
            ];
        })
    };
}

async function markChatRead(userId: string, channelIds: readonly string[]): Promise<void> {
    for (let at = 0; at < channelIds.length; at += core.MAX_CHAT_RECEIPTS) {
        await markChannelsRead(
            { id: userId },
            { channelIds: channelIds.slice(at, at + core.MAX_CHAT_RECEIPTS) }
        );
    }
}

// ---------------------------------------------------------------------------
// Mail
// ---------------------------------------------------------------------------

/** Unread mail as Mail counts it (see `unreadCounts`): the open shelf's
 *  inboxes, not snoozed. */
async function unreadMailWhere(userId: string) {
    return {
        account: onShelf(userId, await mailShelfFor(userId)),
        folder: { role: "inbox" },
        seen: false,
        OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: new Date() } }]
    };
}

/** Unread mail as the badge counts it (see `mailWaitingOnShelf`): the same,
 *  arrived since the badge was last cleared from the app list. */
async function badgeMailWhere(userId: string) {
    const [where, cleared] = await Promise.all([
        unreadMailWhere(userId),
        badgeClearedAt(userId, "mail")
    ]);
    return cleared ? { ...where, createdAt: { gt: cleared } } : where;
}

async function mailGroup(userId: string): Promise<LauncherWaitingGroup | null> {
    const where = await badgeMailWhere(userId);
    const [threads, total] = await Promise.all([
        prisma.mailMessage.groupBy({
            by: ["threadId"],
            where,
            _count: { _all: true },
            _max: { sentAt: true },
            orderBy: { _max: { sentAt: "desc" } },
            take: LAUNCHER_ITEMS_PER_APP
        }),
        prisma.mailMessage.count({ where })
    ]);
    if (total === 0) return null;
    // The newest unread message of each, for who it is from and what about.
    const newest = await prisma.mailMessage.findMany({
        where: { ...where, threadId: { in: threads.map((thread) => thread.threadId) } },
        select: { threadId: true, subject: true, fromJson: true },
        orderBy: { sentAt: "desc" },
        distinct: ["threadId"]
    });
    const byThread = new Map(newest.map((row) => [row.threadId, row]));
    const items: LauncherWaitingItem[] = threads.flatMap((thread) => {
        const row = byThread.get(thread.threadId);
        if (!row) return [];
        const sender = addressesFrom(row.fromJson)[0];
        return [
            {
                id: thread.threadId,
                title: sender ? clipText(core.addressLabel(sender)) : "",
                detail: clipText(row.subject.trim()),
                href: `/mail/t/${thread.threadId}`,
                count: thread._count._all,
                dismissable: true
            }
        ];
    });
    return { app: "mail", total, items };
}

/** One conversation read, the way opening it in Mail reads it: every message
 *  in it, on the mail server too. */
async function markThreadRead(userId: string, threadId: string): Promise<void> {
    const rows = await prisma.mailMessage.findMany({
        where: { ...(await unreadMailWhere(userId)), threadId },
        select: { id: true },
        take: MAIL_BATCH
    });
    if (rows.length === 0) return;
    await actOnMessages(
        userId,
        rows.map((row) => row.id),
        "read",
        { scope: "conversation" }
    );
    await readNoticesAboutThreads(userId, [threadId]);
}

/**
 * Mail's badge cleared from the app list: what it counted stops counting, and
 * every message stays unread in Mail. The bell's notices about those
 * conversations are read with it - they are the app's notifications, and the
 * tab icon counts them - while the mail they point at is not.
 */
async function clearMailBadge(userId: string): Promise<void> {
    const at = new Date();
    const where = await badgeMailWhere(userId);
    const threads = await prisma.mailMessage.findMany({
        where: { AND: [where, { createdAt: { lte: at } }] },
        select: { threadId: true },
        distinct: ["threadId"],
        take: MAIL_NOTICE_THREADS
    });
    await clearAppBadge(userId, "mail", at);
    await readNoticesAboutThreads(
        userId,
        threads.map((row) => row.threadId)
    );
    publishMail({ kind: "badge", accountId: "", actorId: userId });
}

// ---------------------------------------------------------------------------
// Management
// ---------------------------------------------------------------------------

/** Where each Management entry is dealt with. */
const ADMIN_HREF: Record<AdminItemId, string> = {
    reports: "/admin/safety",
    cases: "/admin/safety",
    update: "/admin/updates",
    apis: "/admin/integrations"
};

async function adminGroup(userId: string): Promise<LauncherWaitingGroup | null> {
    const waiting = await adminWaiting(userId);
    if (waiting.total === 0) return null;
    const counts: Record<AdminItemId, number> = {
        reports: waiting.reports,
        cases: waiting.cases,
        update: waiting.update ? 1 : 0,
        apis: waiting.apis
    };
    return {
        app: "admin",
        total: waiting.total,
        items: ADMIN_ITEM_IDS.filter((id) => counts[id] > 0).map((id) => ({
            id,
            title: "",
            detail: "",
            href: ADMIN_HREF[id],
            count: counts[id],
            dismissable: DISMISSABLE_ADMIN_ITEMS.includes(id)
        }))
    };
}

function isAdminItem(id: string): id is AdminItemId {
    return (ADMIN_ITEM_IDS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

/** Everything waiting that this account can reach, one group per app, in the
 *  order the menu draws them. A group that fails to load is left out rather
 *  than failing the others: a mail server that will not answer is no reason
 *  not to list the conversations. */
export async function launcherWaiting(
    userId: string,
    reach: LauncherReach
): Promise<LauncherWaitingGroup[]> {
    const groups = await Promise.all([
        reach.chat ? chatGroup(userId).catch(() => null) : null,
        reach.mail ? mailGroup(userId).catch(() => null) : null,
        reach.admin ? adminGroup(userId).catch(() => null) : null
    ]);
    return groups.filter((group): group is LauncherWaitingGroup => group !== null);
}

/**
 * Clear an app's badge, or mark one named entry read.
 *
 * A whole app - the tile's "mark read", "mark everything read" - clears its
 * badge and nothing inside it: Chat's conversations and Mail's messages are
 * still unread when the app is opened (see `launcher-waiting`). Management's
 * entries are marked seen, which is what its badge counts. One named entry is
 * that entry read, the app's own act. An id that names nothing this account
 * can reach does nothing: Chat and Mail both check ownership on the way in.
 */
export async function markLauncherRead(
    userId: string,
    app: LauncherWaitingApp,
    id: string | null
): Promise<void> {
    if (app === "chat") {
        if (id) {
            await markChatRead(userId, [id]);
            return;
        }
        await clearAppBadge(userId, "chat");
        publishChatChange({ kind: "badge", actorId: userId, audience: [userId] });
        return;
    }
    if (app === "mail") {
        if (id) await markThreadRead(userId, id);
        else await clearMailBadge(userId);
        return;
    }
    if (id && !isAdminItem(id)) return;
    await dismissAdminWaiting(userId, id ? [id as AdminItemId] : DISMISSABLE_ADMIN_ITEMS);
}
