/**
 * Read-only public links to Polar chats. The raw token exists in the URL only:
 * the row keeps its hash for the lookup and an encrypted copy, so the owner can
 * be shown the link again. Revoking deletes the row, and the link answers 404.
 *
 * A link is a snapshot: what was written after it was made is not shown until
 * the owner updates it. Only the words of the conversation are shown - never a
 * tool call or its result, which can carry what the owner's access reached.
 *
 * The same snapshot can be sent to Polaris people instead of (or as well as)
 * being a link: a recipient row per person, read through the share and checked
 * on every read. A snapshot sent only to people has its link switched off, so
 * nobody holding a token reads it.
 *
 * Server-only.
 */

import { readAddressRules, storedAddressRules } from "@/lib/link-guards";
import { linkLimitColumns } from "@/lib/link-limits";
import * as core from "@polaris/core";
import { randomUUID } from "node:crypto";
import { prisma, Prisma, VISIBLE_USER } from "@polaris/db";
import { loadEnv } from "@polaris/config";
import { sharingBaseUrl } from "@/lib/domain-service";
import { decryptSecret, encryptSecret } from "@polaris/storage";
import { generateToken, hashToken } from "@polaris/core/tokens";
import { blockedBetween } from "@/lib/blocks";
import { translatorFor } from "@/lib/i18n/translate";
import { discoverableBy } from "@/lib/privacy-service";
import { compactionOf } from "@/lib/polar/compaction";
import { polarAttachmentId } from "@/lib/polar/shared";
import { isVisualPart, visualOf, visualPartMarkdown } from "@/lib/polar/visuals";
import type {
    OwnedPolarShare,
    PolarShareLink,
    PolarShareRecipientView,
    PolarSharedWithMe,
    ReceivedPolarThread,
    SharedPolarBlock,
    SharedPolarFile,
    SharedPolarThread
} from "@/lib/polar/shared";

export type {
    OwnedPolarShare,
    PolarShareLink,
    PolarShareRecipientView,
    PolarSharedWithMe,
    ReceivedPolarThread,
    SharedPolarFile,
    SharedPolarMessage,
    SharedPolarThread
} from "@/lib/polar/shared";
import { createNotification } from "@/lib/notification-service";
import { readThreadAttachment } from "@/lib/polar/attachments";

async function linkFor(token: string): Promise<string> {
    return `${await sharingBaseUrl()}/c/${token}`;
}

function tokenOf(share: {
    encryptedToken: Uint8Array;
    tokenNonce: Uint8Array;
    tokenKeyId: string;
}) {
    return decryptSecret(
        {
            ciphertext: Buffer.from(share.encryptedToken),
            nonce: Buffer.from(share.tokenNonce),
            keyId: share.tokenKeyId
        },
        loadEnv().POLARIS_MASTER_KEY
    );
}

/** A fresh token's stored columns: its hash for the lookup, an encrypted copy. */
function freshToken() {
    const token = generateToken();
    const blob = encryptSecret(token, loadEnv().POLARIS_MASTER_KEY);
    return {
        tokenHash: hashToken(token),
        encryptedToken: blob.ciphertext,
        tokenNonce: blob.nonce,
        tokenKeyId: blob.keyId
    };
}

/** The chat's link, or null when it is not shared. */
export async function polarShareLink(
    userId: string,
    threadId: string
): Promise<PolarShareLink | null> {
    const share = await prisma.polarThreadShare.findFirst({
        where: { threadId, thread: { userId } },
        select: {
            encryptedToken: true,
            tokenNonce: true,
            tokenKeyId: true,
            sharedAt: true,
            linkEnabled: true,
            views: true,
            passwordHash: true,
            expiresAt: true,
            maxViews: true,
            allowedCidrs: true,
            allowedCountries: true,
            allowedContinents: true
        }
    });
    if (!share || share.linkEnabled === false) return null;
    return {
        url: await linkFor(tokenOf(share)),
        sharedAt: share.sharedAt.toISOString(),
        views: share.views ?? 0,
        hasPassword: Boolean(share.passwordHash),
        expiresAt: share.expiresAt?.toISOString() ?? null,
        maxViews: share.maxViews ?? null,
        ...readAddressRules({
            allowedCidrs: share.allowedCidrs ?? "[]",
            allowedCountries: share.allowedCountries ?? "[]",
            allowedContinents: share.allowedContinents ?? "[]"
        })
    };
}

/**
 * Save the link's limits, without moving its snapshot. The password is only
 * touched when one is typed or it is being taken off. Null when the chat is not
 * this person's or its link is off.
 */
export async function setPolarShareLimits(
    userId: string,
    threadId: string,
    limits: core.LinkLimitsInput
): Promise<PolarShareLink | null> {
    const share = await prisma.polarThreadShare.findFirst({
        where: { threadId, thread: { userId }, linkEnabled: true },
        select: { id: true }
    });
    if (!share) return null;
    await prisma.polarThreadShare.update({
        where: { id: share.id },
        data: await linkLimitColumns(limits)
    });
    return polarShareLink(userId, threadId);
}

/**
 * The answer a snapshot ends at: `upTo` when it is one of this chat's own
 * messages, otherwise null, which shows the whole chat.
 */
async function endOf(threadId: string, upTo: string | null): Promise<string | null> {
    if (!upTo) return null;
    const found = await prisma.polarMessage.count({ where: { id: upTo, threadId } });
    return found ? upTo : null;
}

/** The end point to write: nothing when `upTo` was left out, so an existing
 *  share keeps the one it had. */
async function endAt(
    threadId: string,
    upTo: string | null | undefined
): Promise<{ upToMessageId?: string | null }> {
    return upTo === undefined ? {} : { upToMessageId: await endOf(threadId, upTo) };
}

/**
 * Shares the chat, or moves an existing link's snapshot to now. The address of
 * an existing link stays the same. `upTo` ends the snapshot at that answer
 * (shared from its own row), null makes it the whole chat, and leaving it out
 * keeps the end point the link already had. Null when the chat is not this
 * person's.
 */
export async function sharePolarThread(
    userId: string,
    threadId: string,
    upTo?: string | null
): Promise<PolarShareLink | null> {
    // A temporary chat is deleted when its tab leaves it; a link to it would
    // outlive the chat it promised, so it answers as one that does not exist.
    const owned = await prisma.polarThread.count({
        where: { id: threadId, userId, temporary: false }
    });
    if (!owned) return null;
    const end = await endAt(threadId, upTo);
    const existing = await prisma.polarThreadShare.findUnique({
        where: { threadId },
        select: { id: true }
    });
    if (existing) {
        await prisma.polarThreadShare.update({
            where: { id: existing.id },
            data: { sharedAt: new Date(), linkEnabled: true, ...end }
        });
    } else {
        await prisma.polarThreadShare.create({
            data: { threadId, ...end, ...freshToken() }
        });
    }
    return polarShareLink(userId, threadId);
}

/**
 * Stops serving the link. With `everyone`, or when nobody was sent the chat,
 * the share is deleted outright; otherwise the people keep it and the link's
 * token is replaced, so the old address stays a 404 even if the link is made
 * again, and its views and limits start over with it. Idempotent; false only
 * when the chat is not theirs.
 */
export async function revokePolarShare(
    userId: string,
    threadId: string,
    everyone = false
): Promise<boolean> {
    const owned = await prisma.polarThread.count({ where: { id: threadId, userId } });
    if (!owned) return false;
    const people = everyone
        ? 0
        : await prisma.polarShareRecipient.count({ where: { share: { threadId } } });
    if (people === 0) {
        await prisma.polarThreadShare.deleteMany({ where: { threadId } });
        return true;
    }
    await prisma.polarThreadShare.updateMany({
        where: { threadId },
        data: {
            linkEnabled: false,
            ...freshToken(),
            views: 0,
            passwordHash: null,
            expiresAt: null,
            maxViews: null,
            ...storedAddressRules({})
        }
    });
    return true;
}

/** Most messages a shared page reads. */
const SHARED_MOST = 500;

type Row = { id: string; parentId: string | null; role: string; parts: unknown };

/** A stored message's words, each view it drew as its Markdown. */
function textOf(parts: unknown): string {
    if (!Array.isArray(parts)) return "";
    return parts
        .map((part) => {
            if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
                return String((part as { text?: unknown }).text ?? "");
            }
            const visual = visualPartMarkdown(part as never);
            return visual ? `\n\n${visual}\n\n` : "";
        })
        .join("")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

/** A stored message's words and views in order, or undefined when it drew none. */
function blocksOf(parts: unknown): SharedPolarBlock[] | undefined {
    if (!Array.isArray(parts)) return undefined;
    const blocks: SharedPolarBlock[] = [];
    let drew = false;
    for (const part of parts) {
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
            const text = String((part as { text?: unknown }).text ?? "");
            const last = blocks.at(-1);
            if (last?.kind === "text") last.text += text;
            else if (text.trim()) blocks.push({ kind: "text", text });
            continue;
        }
        if (!isVisualPart(part as never)) continue;
        const visual = visualOf((part as { input?: unknown }).input);
        if (!visual) continue;
        drew = true;
        blocks.push({ kind: "visual", visual });
    }
    return drew ? blocks : undefined;
}

/** Polar's own files a message carries; any other address is left out. */
function filesOf(parts: unknown): SharedPolarFile[] {
    if (!Array.isArray(parts)) return [];
    return parts.flatMap((part) => {
        if (!part || typeof part !== "object") return [];
        const file = part as {
            type?: unknown;
            url?: unknown;
            filename?: unknown;
            mediaType?: unknown;
        };
        if (file.type !== "file" || typeof file.url !== "string") return [];
        const id = polarAttachmentId(file.url);
        if (!id) return [];
        return [
            {
                id,
                name: typeof file.filename === "string" && file.filename ? file.filename : null,
                mediaType: typeof file.mediaType === "string" ? file.mediaType : ""
            }
        ];
    });
}

/**
 * The conversation as the screen last showed it: from the newest first message,
 * always the newest answer to each one (an edited message's newest version).
 * Rows come oldest first.
 */
export function newestPath<T extends Row>(rows: readonly T[]): T[] {
    const children = new Map<string | null, T[]>();
    const ids = new Set(rows.map((row) => row.id));
    for (const row of rows) {
        const parent = row.parentId && ids.has(row.parentId) ? row.parentId : null;
        children.set(parent, [...(children.get(parent) ?? []), row]);
    }
    const path: T[] = [];
    const seen = new Set<string>();
    let next = children.get(null)?.at(-1);
    while (next && !seen.has(next.id)) {
        seen.add(next.id);
        path.push(next);
        next = children.get(next.id)?.at(-1);
    }
    return path;
}

/**
 * The conversation that led to one message: its first message, each answer
 * and question in between, and the message itself - whichever versions it
 * grew from, not the newest ones. Null when `id` is not among the rows.
 */
export function pathTo<T extends Row>(rows: readonly T[], id: string): T[] | null {
    const byId = new Map(rows.map((row) => [row.id, row]));
    const path: T[] = [];
    const seen = new Set<string>();
    let next = byId.get(id);
    if (!next) return null;
    while (next && !seen.has(next.id)) {
        seen.add(next.id);
        path.unshift(next);
        next = next.parentId ? byId.get(next.parentId) : undefined;
    }
    return path;
}

type SnapshotShare = {
    threadId: string;
    sharedAt: Date;
    upToMessageId?: string | null;
    thread: { title: string };
};

/** The words (and Polar's own files) of a thread up to a snapshot. */
async function snapshotOf(share: SnapshotShare): Promise<SharedPolarThread> {
    const rows = await prisma.polarMessage.findMany({
        where: { threadId: share.threadId, createdAt: { lte: share.sharedAt } },
        select: { id: true, parentId: true, role: true, parts: true, metadata: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: SHARED_MOST
    });
    return {
        title: share.thread.title,
        sharedAt: share.sharedAt.toISOString(),
        messages: (
            (share.upToMessageId ? pathTo(rows, share.upToMessageId) : null) ?? newestPath(rows)
        )
            .filter((row) => row.role === "user" || row.role === "assistant")
            .filter((row) => !compactionOf(row))
            .map((row) => ({
                id: row.id,
                role: row.role as "user" | "assistant",
                text: textOf(row.parts),
                files: filesOf(row.parts),
                blocks: blocksOf(row.parts)
            }))
            .filter((row) => row.text.length > 0 || row.files.length > 0)
    };
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

async function shareByToken(token: string) {
    if (!TOKEN_SHAPE.test(token)) return null;
    const share = await prisma.polarThreadShare.findUnique({
        where: { tokenHash: hashToken(token) },
        select: {
            sharedAt: true,
            threadId: true,
            linkEnabled: true,
            upToMessageId: true,
            thread: { select: { title: true } }
        }
    });
    return share && share.linkEnabled !== false ? share : null;
}

/** What a public link shows, or null for a token that is not a live link. */
export async function readSharedPolarThread(token: string): Promise<SharedPolarThread | null> {
    const share = await shareByToken(token);
    return share ? snapshotOf(share) : null;
}

type FileStream = Awaited<ReturnType<typeof readThreadAttachment>>;

/** How long a snapshot's file list is reused, and how many are kept. */
const SNAPSHOT_FILES_TTL_MS = 60_000;
const SNAPSHOT_FILES_MOST = 500;

/**
 * The ids of the files a snapshot shows, read once per snapshot for a minute:
 * a page with a dozen pictures asks for a dozen files at once, and each would
 * otherwise read the whole thread again. Keyed by the snapshot's moment, so
 * moving the snapshot reads afresh.
 */
const snapshotFiles = new Map<string, { at: number; ids: Promise<Set<string>> }>();

function filesShownBy(share: SnapshotShare): Promise<Set<string>> {
    const key = `${share.threadId}:${share.sharedAt.getTime()}`;
    const now = Date.now();
    const hit = snapshotFiles.get(key);
    if (hit && now - hit.at < SNAPSHOT_FILES_TTL_MS) return hit.ids;
    snapshotFiles.delete(key);
    while (snapshotFiles.size >= SNAPSHOT_FILES_MOST) {
        const oldest = snapshotFiles.keys().next().value;
        if (oldest === undefined) break;
        snapshotFiles.delete(oldest);
    }
    const ids = snapshotOf(share).then(
        (snapshot) =>
            new Set(snapshot.messages.flatMap((message) => message.files.map((file) => file.id)))
    );
    snapshotFiles.set(key, { at: now, ids });
    ids.catch(() => {
        if (snapshotFiles.get(key)?.ids === ids) snapshotFiles.delete(key);
    });
    return ids;
}

/** A file the snapshot shows, read only because the snapshot shows it. */
async function fileInSnapshot(share: SnapshotShare, fileId: string): Promise<FileStream> {
    const shown = (await filesShownBy(share)).has(fileId);
    return shown ? readThreadAttachment(share.threadId, fileId) : null;
}

/** A file of a public link's snapshot, or null when the link does not show it. */
export async function readSharedPolarFileByToken(
    token: string,
    fileId: string
): Promise<FileStream> {
    const share = await shareByToken(token);
    return share ? fileInSnapshot(share, fileId) : null;
}

// ---------------------------------------------------------------------------
// Sent to people
// ---------------------------------------------------------------------------

/** Most people one chat is sent to, and most named in one send. */
export const POLAR_SHARE_PEOPLE_MOST = 50;
export const POLAR_SHARE_SEND_MOST = 20;
/** Longest note sent with a chat. */
export const POLAR_SHARE_NOTE_MAX = 500;
/** Most rows a list of shares reads. */
const LIST_MOST = 100;

/** Their name, else their handle; null leaves the word to the reader's language. */
function personName(user: { name: string | null; username: string | null }): string | null {
    return user.name || (user.username ? `@${user.username}` : null);
}

/** Who the chat was sent to, oldest first. Null when the chat is not theirs. */
export async function listShareRecipients(
    userId: string,
    threadId: string
): Promise<PolarShareRecipientView[] | null> {
    const owned = await prisma.polarThread.count({ where: { id: threadId, userId } });
    if (!owned) return null;
    const rows = await prisma.polarShareRecipient.findMany({
        where: { share: { threadId } },
        select: { userId: true, createdAt: true, user: { select: { name: true, username: true } } },
        orderBy: { createdAt: "asc" },
        take: POLAR_SHARE_PEOPLE_MOST
    });
    return rows.map((row) => ({
        userId: row.userId,
        name: personName(row.user),
        sentAt: row.createdAt.toISOString()
    }));
}

export type SendPolarShareResult =
    | { ok: true; sent: number; recipients: PolarShareRecipientView[] }
    | { ok: false; error: "not_found" | "unavailable" | "too_many" };

/**
 * Sends the chat, as it is now, to Polaris people. Only people the sender could
 * find in the people search may be named - the same discoverability and block
 * rules, checked here again rather than trusted from the picker. Someone who
 * already has it is not told twice. The snapshot moves to now, for the link too.
 */
export async function sendPolarShare(
    sender: { id: string; name: string | null },
    threadId: string,
    userIds: readonly string[],
    note: string | null,
    upTo?: string | null
): Promise<SendPolarShareResult> {
    const thread = await prisma.polarThread.findFirst({
        // Temporary chats are never sent, for the same reason they have no link.
        where: { id: threadId, userId: sender.id, temporary: false },
        select: { title: true }
    });
    if (!thread) return { ok: false, error: "not_found" };
    const wanted = [...new Set(userIds)].filter((id) => id !== sender.id);
    // Someone barred from Polar could not open what the bell points at, so
    // they are refused here like someone the sender cannot find. Loaded here,
    // not at the top: the access check reaches the session, and the public
    // link's page reads this module without one.
    const { polarUsersAmong } = await import("@/lib/polar/access");
    const [found, visible, blocked, polarUsers] = await Promise.all([
        prisma.user.findMany({
            where: { id: { in: wanted }, ...VISIBLE_USER },
            select: { id: true }
        }),
        discoverableBy({ id: sender.id, isAdmin: false }, wanted),
        blockedBetween(sender.id, wanted),
        polarUsersAmong(wanted)
    ]);
    const allowed = found
        .map((row) => row.id)
        .filter((id) => visible.has(id) && !blocked.has(id) && polarUsers.has(id));
    if (allowed.length !== wanted.length || wanted.length === 0)
        return { ok: false, error: "unavailable" };

    const existing = await prisma.polarThreadShare.findUnique({
        where: { threadId },
        select: { id: true, recipients: { select: { userId: true } } }
    });
    const already = new Set(existing?.recipients.map((row) => row.userId) ?? []);
    const fresh = allowed.filter((id) => !already.has(id));
    if (already.size + fresh.length > POLAR_SHARE_PEOPLE_MOST)
        return { ok: false, error: "too_many" };

    const shareId = existing
        ? (
              await prisma.polarThreadShare.update({
                  where: { id: existing.id },
                  data: { sharedAt: new Date(), ...(await endAt(threadId, upTo)) },
                  select: { id: true }
              })
          ).id
        : (
              await prisma.polarThreadShare.create({
                  data: {
                      threadId,
                      linkEnabled: false,
                      ...(await endAt(threadId, upTo)),
                      ...freshToken()
                  },
                  select: { id: true }
              })
          ).id;
    await prisma.polarShareRecipient.createMany({
        data: fresh.map((userId) => ({ shareId, userId, note })),
        skipDuplicates: true
    });
    const made = await prisma.polarShareRecipient.findMany({
        where: { shareId, userId: { in: fresh } },
        select: { id: true, userId: true }
    });
    await Promise.all(made.map((row) => tellRecipient(row, sender.name, thread.title, note)));
    return {
        ok: true,
        sent: fresh.length,
        recipients: (await listShareRecipients(sender.id, threadId)) ?? []
    };
}

/** The bell, in the recipient's own language. Best-effort. */
async function tellRecipient(
    row: { id: string; userId: string },
    senderName: string | null,
    title: string,
    note: string | null
): Promise<void> {
    let words = translatorFor(core.DEFAULT_LOCALE, "polar");
    try {
        const { getUserLocale } = await import("@/lib/i18n/locale-service");
        words = translatorFor(await getUserLocale(row.userId), "polar");
    } catch {
        // The default language, then.
    }
    await createNotification({
        userId: row.userId,
        type: "polar.shared",
        title: words("sharing.notice", { name: senderName || words("sharing.somebody") }),
        body: note ? `${title} - ${note}` : title,
        href: `/polar/shared/${row.id}`,
        level: "info"
    });
}

/** Takes the chat back from one person. Idempotent; false when it is not theirs. */
export async function removeShareRecipient(
    userId: string,
    threadId: string,
    recipientUserId: string
): Promise<boolean> {
    const owned = await prisma.polarThread.count({ where: { id: threadId, userId } });
    if (!owned) return false;
    await prisma.polarShareRecipient.deleteMany({
        where: { userId: recipientUserId, share: { threadId } }
    });
    // A snapshot nobody can reach any more is not kept.
    await prisma.polarThreadShare.deleteMany({
        where: { threadId, linkEnabled: false, recipients: { none: {} } }
    });
    return true;
}

/** Every chat this person shares, newest snapshot first. */
export async function listOwnedPolarShares(userId: string): Promise<OwnedPolarShare[]> {
    const rows = await prisma.polarThreadShare.findMany({
        where: { thread: { userId } },
        select: {
            threadId: true,
            sharedAt: true,
            linkEnabled: true,
            encryptedToken: true,
            tokenNonce: true,
            tokenKeyId: true,
            thread: { select: { title: true } },
            _count: { select: { recipients: true } }
        },
        orderBy: { sharedAt: "desc" },
        take: LIST_MOST
    });
    const base = await sharingBaseUrl();
    return rows.map((row) => ({
        threadId: row.threadId,
        title: row.thread.title,
        sharedAt: row.sharedAt.toISOString(),
        url: row.linkEnabled === false ? null : `${base}/c/${tokenOf(row)}`,
        people: row._count.recipients
    }));
}

/** Chats other people sent this person, newest first. */
export async function listSharedWithMe(userId: string): Promise<PolarSharedWithMe[]> {
    const rows = await prisma.polarShareRecipient.findMany({
        where: { userId },
        select: {
            id: true,
            note: true,
            share: {
                select: {
                    sharedAt: true,
                    thread: {
                        select: { title: true, user: { select: { name: true, username: true } } }
                    }
                }
            }
        },
        orderBy: { createdAt: "desc" },
        take: LIST_MOST
    });
    return rows.map((row) => ({
        id: row.id,
        title: row.share.thread.title,
        from: personName(row.share.thread.user),
        note: row.note,
        sharedAt: row.share.sharedAt.toISOString()
    }));
}

const RECIPIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The share behind one of this person's "shared with you" rows. */
async function receivedShare(userId: string, recipientId: string) {
    if (!RECIPIENT_ID.test(recipientId)) return null;
    const row = await prisma.polarShareRecipient.findFirst({
        where: { id: recipientId, userId },
        select: {
            note: true,
            share: {
                select: {
                    threadId: true,
                    sharedAt: true,
                    upToMessageId: true,
                    thread: {
                        select: {
                            title: true,
                            user: { select: { name: true, username: true } }
                        }
                    }
                }
            }
        }
    });
    return row;
}

/** A chat sent to this person, or null when it is not (or no longer) theirs. */
export async function readReceivedPolarThread(
    userId: string,
    recipientId: string
): Promise<ReceivedPolarThread | null> {
    const row = await receivedShare(userId, recipientId);
    if (!row) return null;
    return {
        ...(await snapshotOf(row.share)),
        from: personName(row.share.thread.user),
        note: row.note
    };
}

/** A file of a chat sent to this person, or null when the snapshot does not show it. */
export async function readReceivedPolarFile(
    userId: string,
    recipientId: string,
    fileId: string
): Promise<FileStream> {
    const row = await receivedShare(userId, recipientId);
    return row ? fileInSnapshot(row.share, fileId) : null;
}

/** Takes a chat off this person's own "shared with you" list. Idempotent. */
export async function dismissReceivedPolarThread(
    userId: string,
    recipientId: string
): Promise<void> {
    if (!RECIPIENT_ID.test(recipientId)) return;
    await prisma.polarShareRecipient.deleteMany({ where: { id: recipientId, userId } });
}

/**
 * Copies a chat sent to this person into a new chat of their own, so they can
 * carry on from it. The words come over; the files stay the owner's, since a
 * new chat that pointed at them would be reading someone else's storage.
 * Null when the chat is not (or no longer) theirs to read.
 */
export async function continueReceivedPolarThread(
    userId: string,
    recipientId: string
): Promise<string | null> {
    const shared = await readReceivedPolarThread(userId, recipientId);
    if (!shared) return null;
    const messages = shared.messages.filter((message) => message.text.length > 0);
    return prisma.$transaction(async (tx) => {
        const thread = await tx.polarThread.create({
            data: { userId, title: shared.title, titleSource: "user" },
            select: { id: true }
        });
        const base = Date.now();
        let parentId: string | null = null;
        const data = messages.map((message, index) => {
            const id = randomUUID();
            const row = {
                id,
                threadId: thread.id,
                parentId,
                role: message.role,
                parts: [{ type: "text", text: message.text }] as Prisma.InputJsonValue,
                // One millisecond apart, so the order they were written in is kept.
                createdAt: new Date(base + index)
            };
            parentId = id;
            return row;
        });
        if (data.length > 0) await tx.polarMessage.createMany({ data });
        return thread.id;
    });
}
