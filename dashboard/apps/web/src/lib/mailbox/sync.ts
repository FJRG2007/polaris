/**
 * Keeping Polaris's copy of a mailbox in step with the server's.
 *
 * The whole design rests on one decision: **the server is right about
 * everything.** Polaris never invents a message, never keeps one the server has
 * dropped, and never disagrees with a flag. What it holds is a window onto the
 * newest part of each folder, wide enough that scrolling feels instant and
 * narrow enough that adding a mailbox with two hundred thousand messages in it
 * finishes in under a minute.
 *
 * A pass costs four commands per folder and no more:
 *
 * 1. Open it, and read what the server says about it - how many messages, which
 *    uid comes next, and its uid validity.
 * 2. If the validity has moved, every uid held here means nothing and the folder
 *    is emptied. It happens rarely and it is the one thing that silently
 *    corrupts a mail cache when it is not handled.
 * 3. Fetch envelopes for the uids arrived since last time, or for the newest
 *    page if this is the first pass.
 * 4. Ask for the flags that have changed since the last modseq, where the server
 *    keeps one, and reconcile deletions from a uid search.
 *
 * Nothing here fetches a body. Bodies arrive when somebody opens a message,
 * because a mailbox is mostly messages nobody will ever open again.
 */

import { withImap } from "./imap";
import { prisma } from "@polaris/db";
import { publishMail } from "./live";
import * as core from "@polaris/core";
import { readShape } from "./structure";
import { addressesFrom, asJson } from "./json";
import { ACCOUNT_COLUMNS } from "./access";
import { rememberContacts } from "./contacts";
import { replyIfAway } from "./vacation";
import { applyRulesToMessage } from "./rules";
import { MailAuthError } from "./credentials";
import { recordAccountState } from "./accounts";
import type { ImapFlow, MessageAddressObject, MessageEnvelopeObject } from "imapflow";

/** How many messages of a folder are held. Four hundred is roughly two years of
 *  a working inbox and about eight screens of scrolling; past it the answer is
 *  the search box, which asks the server. */
const WINDOW = 400;

/** A folder with no role and nobody subscribed to it is not synced: an IMAP
 *  account has dozens, and syncing all of them is why other clients take an hour
 *  to add one. */
function worthSyncing(folder: { role: string; subscribed: boolean; hidden: boolean }): boolean {
    return !folder.hidden && (folder.role !== "none" || folder.subscribed);
}

/**
 * One pass over one account.
 *
 * Never throws: a mailbox that cannot be reached leaves its reason on itself and
 * the rail says so. Throwing would mean one dead mailbox stopping the sweep for
 * every other account on the instance.
 */
export async function syncAccount(accountId: string): Promise<void> {
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: ACCOUNT_COLUMNS
    });
    if (!account) return;

    try {
        await withImap(account, async (client) => {
            await syncFolders(client, account.id);
            const folders = await prisma.mailFolder.findMany({
                where: { accountId: account.id },
                orderBy: { role: "asc" }
            });
            for (const folder of folders) {
                if (!worthSyncing(folder)) continue;
                await syncFolder(client, account, folder);
            }
        });
        await recordAccountState(accountId, "ok");
    } catch (caught) {
        const auth = caught instanceof MailAuthError;
        await recordAccountState(accountId, auth ? "auth" : "unreachable", auth ? caught.message : "");
        if (!auth) {
            // The server's own words are useful once, in the log. They name hosts
            // and internal paths, so they never reach the screen.
            console.warn("mail sync failed", accountId, caught instanceof Error ? caught.message : caught);
        }
    }
    publishMail({ accountId, kind: "folders", actorId: account.userId });
}

/* -------------------------------------------------------------------------- */
/* Folders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Bring the folder list in line with the server's.
 *
 * A folder the server no longer lists is deleted here, with everything cached in
 * it - it is a cache, and a folder that does not exist is not something to keep
 * a copy of. What survives is what Polaris added: a label applied to a message
 * finds its way back by the message's own header id when the message reappears
 * somewhere else.
 */
async function syncFolders(client: ImapFlow, accountId: string): Promise<void> {
    const listed = await client.list({ statusQuery: { messages: true, unseen: true } });
    const seen = new Set<string>();

    for (const entry of listed) {
        // A folder that cannot hold messages is a heading in somebody's tree,
        // not a place to sync.
        if (entry.flags.has("\\Noselect") || entry.flags.has("\\NonExistent")) continue;
        seen.add(entry.path);
        const role = core.folderRole(entry.path, [...entry.flags], entry.delimiter);
        const existing = await prisma.mailFolder.findUnique({
            where: { accountId_path: { accountId, path: entry.path } },
            select: { id: true, subscribed: true }
        });
        const data = {
            delimiter: entry.delimiter || "/",
            name: core.folderLabel(entry.path, entry.delimiter),
            role,
            total: entry.status?.messages ?? 0,
            unread: entry.status?.unseen ?? 0
        };
        if (existing) {
            await prisma.mailFolder.update({ where: { id: existing.id }, data });
        } else {
            await prisma.mailFolder.create({
                data: {
                    accountId,
                    path: entry.path,
                    ...data,
                    // A folder with a role is one everybody uses, so it arrives
                    // on. Everything else takes the server's own answer, and a
                    // server that reports no subscription state at all says
                    // subscribed, which imapflow already resolves.
                    subscribed: role !== "none" || entry.subscribed
                }
            });
        }
    }

    const gone = await prisma.mailFolder.findMany({
        where: { accountId, path: { notIn: [...seen] } },
        select: { id: true }
    });
    if (gone.length > 0) {
        await prisma.mailFolder.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } });
    }
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                    */
/* -------------------------------------------------------------------------- */

type AccountRow = { id: string; userId: string; address: string };
type FolderRow = {
    id: string;
    path: string;
    role: string;
    uidValidity: bigint | null;
    uidNext: bigint | null;
    highestModseq: bigint | null;
};

async function syncFolder(client: ImapFlow, account: AccountRow, folder: FolderRow): Promise<void> {
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
        const mailbox = client.mailbox;
        if (!mailbox || typeof mailbox === "boolean") return;

        // The one thing that silently corrupts a mail cache. A server may reissue
        // uids from one after a restore, and every uid held here would then point
        // at a different message. The only correct answer is to forget the lot.
        const validityMoved =
            folder.uidValidity !== null && folder.uidValidity !== BigInt(mailbox.uidValidity);
        if (validityMoved) {
            await prisma.mailMessage.deleteMany({ where: { folderId: folder.id } });
        }

        const known = validityMoved ? null : folder.uidNext;
        const arrived = known
            ? await fetchSince(client, known)
            : await fetchNewest(client, mailbox.exists);
        if (arrived.length > 0) await storeMessages(client, account, folder, arrived);

        if (!validityMoved) {
            await reconcileFlags(client, folder, mailbox.highestModseq ?? null);
            await reconcileDeletions(client, folder);
        }

        await prisma.mailFolder.update({
            where: { id: folder.id },
            data: {
                uidValidity: BigInt(mailbox.uidValidity),
                uidNext: BigInt(mailbox.uidNext),
                highestModseq: mailbox.highestModseq ?? null,
                total: mailbox.exists,
                lastSyncAt: new Date()
            }
        });
    } finally {
        lock.release();
    }
}

/** What one fetch answers with, before it becomes a row. */
interface Fetched {
    uid: number;
    flags: Set<string>;
    envelope: MessageEnvelopeObject | undefined;
    internalDate: Date | undefined;
    size: number;
    structure: ReturnType<typeof readShape>;
    headers: Record<string, string>;
}

const QUERY = {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    size: true,
    bodyStructure: true,
    // The handful of headers a client acts on. Asking for all of them would
    // double what an envelope costs for a hundred lines nothing reads.
    headers: [
        "references",
        "list-id",
        "list-unsubscribe",
        "list-unsubscribe-post",
        "disposition-notification-to",
        "return-receipt-to",
        "authentication-results",
        "auto-submitted",
        "precedence",
        "x-mailer",
        "user-agent"
    ]
};

async function collect(client: ImapFlow, range: string, options: { uid: boolean }): Promise<Fetched[]> {
    const out: Fetched[] = [];
    for await (const message of client.fetch(range, QUERY, options)) {
        out.push({
            uid: message.uid,
            flags: message.flags ?? new Set<string>(),
            envelope: message.envelope,
            internalDate:
                message.internalDate instanceof Date
                    ? message.internalDate
                    : message.internalDate
                      ? new Date(message.internalDate)
                      : undefined,
            size: message.size ?? 0,
            structure: readShape(message.bodyStructure),
            headers: parseHeaders(message.headers)
        });
    }
    return out;
}

/** Everything that has arrived since the uid this folder was last read to. */
function fetchSince(client: ImapFlow, uidNext: bigint): Promise<Fetched[]> {
    return collect(client, `${uidNext}:*`, { uid: true });
}

/** The newest page of a folder nobody has read yet, by sequence number, because
 *  uids are not contiguous and counting back from the newest one would ask for
 *  a range that is mostly gaps. */
function fetchNewest(client: ImapFlow, exists: number): Promise<Fetched[]> {
    if (exists === 0) return Promise.resolve([]);
    const from = Math.max(1, exists - WINDOW + 1);
    return collect(client, `${from}:${exists}`, { uid: false });
}

/** Headers as a flat map, lowercased. Repeated ones are joined, which is what
 *  References needs and what the rest are never sent as. */
function parseHeaders(raw: Buffer | undefined): Record<string, string> {
    if (!raw) return {};
    const out: Record<string, string> = {};
    let name = "";
    for (const line of raw.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (/^\s/.test(line) && name) {
            out[name] = `${out[name] ?? ""} ${line.trim()}`;
            continue;
        }
        const at = line.indexOf(":");
        if (at === -1) continue;
        name = line.slice(0, at).trim().toLowerCase();
        const value = line.slice(at + 1).trim();
        out[name] = out[name] ? `${out[name]} ${value}` : value;
    }
    return out;
}

function addresses(entries: MessageAddressObject[] | undefined): core.MailAddress[] {
    return (entries ?? [])
        .filter((entry) => entry.address)
        .map((entry) => ({ name: entry.name ?? "", address: (entry.address ?? "").toLowerCase() }));
}

/**
 * Write a page of messages, thread them, and let the rules at the new ones.
 *
 * Snippets are fetched in a second pass grouped by which part holds the text,
 * because the part number differs between messages and a fetch names one key for
 * the whole range. In practice there are two or three distinct keys in any page,
 * so it is two or three commands rather than one per message.
 */
async function storeMessages(
    client: ImapFlow,
    account: AccountRow,
    folder: FolderRow,
    fetched: readonly Fetched[]
): Promise<void> {
    const snippets = await fetchSnippets(client, fetched);

    for (const message of fetched) {
        const envelope = message.envelope;
        const from = addresses(envelope?.from);
        const to = addresses(envelope?.to);
        const cc = addresses(envelope?.cc);
        const references = (message.headers.references ?? "")
            .split(/\s+/)
            .map(core.bareMessageId)
            .filter(Boolean);
        const sentAt = envelope?.date ?? message.internalDate ?? new Date();
        const shape = {
            messageId: core.bareMessageId(envelope?.messageId ?? ""),
            inReplyTo: core.bareMessageId(envelope?.inReplyTo ?? ""),
            references,
            subject: envelope?.subject ?? "",
            from,
            to,
            cc,
            listId: message.headers["list-id"] ?? "",
            sentAt
        } satisfies core.MailEnvelope;

        const threadId = await threadFor(account.id, shape);
        const snippet = core.snippetFrom(snippets.get(message.uid) ?? "");

        const row = await prisma.mailMessage.upsert({
            where: { folderId_uid: { folderId: folder.id, uid: BigInt(message.uid) } },
            update: {
                seen: message.flags.has("\\Seen"),
                flagged: message.flags.has("\\Flagged"),
                answered: message.flags.has("\\Answered"),
                deleted: message.flags.has("\\Deleted")
            },
            create: {
                accountId: account.id,
                folderId: folder.id,
                threadId,
                uid: BigInt(message.uid),
                messageId: shape.messageId,
                inReplyTo: shape.inReplyTo,
                references,
                listId: shape.listId,
                subject: shape.subject,
                fromJson: asJson(from),
                toJson: asJson(to),
                ccJson: asJson(cc),
                replyToJson: asJson(addresses(envelope?.replyTo)),
                snippet,
                sentAt,
                receivedAt: message.internalDate ?? sentAt,
                size: message.size,
                seen: message.flags.has("\\Seen"),
                flagged: message.flags.has("\\Flagged"),
                answered: message.flags.has("\\Answered"),
                draft: message.flags.has("\\Draft"),
                deleted: message.flags.has("\\Deleted"),
                hasAttachments: message.structure.hasAttachments,
                wantsReceipt: Boolean(
                    message.headers["disposition-notification-to"] ?? message.headers["return-receipt-to"]
                ),
                headers: message.headers,
                attachments: {
                    create: message.structure.attachments.map((part) => ({
                        part: part.part,
                        name: part.name,
                        contentType: part.contentType,
                        size: BigInt(part.size),
                        contentId: part.contentId,
                        inline: part.inline
                    }))
                }
            },
            select: { id: true, createdAt: true, updatedAt: true }
        });

        // Only what is new gets the rules and the contact collection run over it:
        // a folder resynced from scratch must not re-file a year of mail or
        // re-count everybody in it.
        const isNew = row.createdAt.getTime() === row.updatedAt.getTime();
        if (isNew) {
            await rememberContacts(account.id, folder.role, { from, to, cc });
            if (folder.role === "inbox") {
                await applyRulesToMessage(account.id, row.id);
                // After the rules, so a message a filter sent to junk is not
                // answered with an away message.
                await replyIfAway(account.id, row.id);
            }
        }
    }

    await refreshThreads(account.id);
    publishMail({ accountId: account.id, kind: "messages", actorId: account.userId, folderId: folder.id });
}

/** The first few kilobytes of each message's text part, for the line under the
 *  subject. A message with no text part gets none, which is what a picture-only
 *  newsletter is. */
async function fetchSnippets(
    client: ImapFlow,
    fetched: readonly Fetched[]
): Promise<Map<number, string>> {
    const byPart = new Map<string, number[]>();
    for (const message of fetched) {
        const key = message.structure.textPart || message.structure.htmlPart;
        if (!key) continue;
        const held = byPart.get(key);
        if (held) held.push(message.uid);
        else byPart.set(key, [message.uid]);
    }

    const out = new Map<number, string>();
    for (const [key, uids] of byPart) {
        try {
            for await (const message of client.fetch(
                uids,
                { uid: true, bodyParts: [{ key, maxLength: 4096 }] },
                { uid: true }
            )) {
                const bytes = message.bodyParts?.get(key.toLowerCase()) ?? message.bodyParts?.get(key);
                if (!bytes) continue;
                const text = bytes.toString("utf8");
                out.set(message.uid, key === (fetched.find((one) => one.uid === message.uid)?.structure.htmlPart ?? "")
                    ? stripTags(text)
                    : text);
            }
        } catch {
            // A snippet is a nicety. A server that will not answer for one part
            // must not cost the page it belongs to.
        }
    }
    return out;
}

/** Enough tag stripping for a preview line. Never used to render anything: what
 *  is shown as HTML goes through the sanitizer. */
function stripTags(html: string): string {
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

/* -------------------------------------------------------------------------- */
/* Threading                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The conversation this message joins, made if there is not one yet.
 *
 * Candidates are narrowed in the database rather than walked in memory: the id
 * match is a lookup of the ids this message names, and the subject match is one
 * query for the same key inside the window. A mailbox with forty thousand
 * conversations in it cannot be a scan.
 */
async function threadFor(accountId: string, envelope: core.MailEnvelope): Promise<string> {
    const ids = core.conversationIds(envelope);
    if (ids.length > 0) {
        const related = await prisma.mailMessage.findFirst({
            where: { accountId, messageId: { in: [...ids] } },
            select: { threadId: true },
            orderBy: { sentAt: "asc" }
        });
        if (related) return related.threadId;
        // A reply that arrived before the message it answers: somebody else's
        // message names this one, so they are the same conversation.
        const answered = await prisma.mailMessage.findFirst({
            where: { accountId, inReplyTo: envelope.messageId },
            select: { threadId: true }
        });
        if (answered) return answered.threadId;
    }

    const key = core.subjectThreadKey(envelope);
    if (key) {
        const since = new Date(envelope.sentAt.getTime() - core.SUBJECT_THREAD_WINDOW_MS);
        const until = new Date(envelope.sentAt.getTime() + core.SUBJECT_THREAD_WINDOW_MS);
        const nearby = await prisma.mailThread.findFirst({
            where: { accountId, subjectKey: key, lastMessageAt: { gte: since, lte: until } },
            select: { id: true },
            orderBy: { lastMessageAt: "desc" }
        });
        if (nearby) return nearby.id;
    }

    const created = await prisma.mailThread.create({
        data: {
            accountId,
            subjectKey: key,
            subject: envelope.subject,
            participants: asJson(core.dedupeAddresses([...envelope.from, ...envelope.to])),
            lastMessageAt: envelope.sentAt,
            firstMessageAt: envelope.sentAt
        },
        select: { id: true }
    });
    return created.id;
}

/**
 * Bring every conversation's summary back in line with the messages in it.
 *
 * Held rather than computed on read because the list draws all of it for every
 * row - who is in it, how many, how many unread, whether anything is attached -
 * and a list of fifty conversations would otherwise be fifty aggregate queries.
 * Run once at the end of a page rather than per message, so a page of thirty
 * replies to one conversation costs one recount.
 */
export async function refreshThreads(accountId: string): Promise<void> {
    const stale = await prisma.mailThread.findMany({
        where: { accountId },
        select: { id: true },
        orderBy: { lastMessageAt: "desc" },
        take: 500
    });
    for (const thread of stale) {
        const messages = await prisma.mailMessage.findMany({
            where: { threadId: thread.id },
            select: {
                seen: true,
                flagged: true,
                sentAt: true,
                snippet: true,
                subject: true,
                fromJson: true,
                toJson: true,
                hasAttachments: true
            },
            orderBy: { sentAt: "asc" }
        });
        if (messages.length === 0) {
            await prisma.mailThread.delete({ where: { id: thread.id } }).catch(() => undefined);
            continue;
        }
        const newest = messages.at(-1);
        const oldest = messages[0];
        if (!newest || !oldest) continue;
        const participants = core.dedupeAddresses(
            messages.flatMap((message) => [
                ...addressesFrom(message.fromJson),
                ...addressesFrom(message.toJson)
            ])
        );
        await prisma.mailThread.update({
            where: { id: thread.id },
            data: {
                subject: oldest.subject,
                participants: asJson(participants),
                messageCount: messages.length,
                unreadCount: messages.filter((message) => !message.seen).length,
                starred: messages.some((message) => message.flagged),
                hasAttachments: messages.some((message) => message.hasAttachments),
                snippet: newest.snippet,
                firstMessageAt: oldest.sentAt,
                lastMessageAt: newest.sentAt
            }
        });
    }
}

/* -------------------------------------------------------------------------- */
/* Reconciling                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Flags that moved somewhere else.
 *
 * Somebody reads a message on their phone and it has to be read here too. Where
 * the server keeps a modseq this is one command for everything that changed
 * since last time; where it does not, the flags of the window are asked for
 * outright, which is one command and a few kilobytes.
 */
async function reconcileFlags(
    client: ImapFlow,
    folder: FolderRow,
    highestModseq: bigint | null
): Promise<void> {
    const held = await prisma.mailMessage.findMany({
        where: { folderId: folder.id },
        select: { id: true, uid: true, seen: true, flagged: true, answered: true },
        orderBy: { uid: "desc" },
        take: WINDOW
    });
    if (held.length === 0) return;

    const changed = new Map<number, Set<string>>();
    const uids = held.map((row) => Number(row.uid));
    const useModseq = folder.highestModseq !== null && highestModseq !== null && highestModseq > folder.highestModseq;
    try {
        for await (const message of client.fetch(
            useModseq ? { uid: `${Math.min(...uids)}:*` } : uids,
            { uid: true, flags: true },
            { uid: true, ...(useModseq && folder.highestModseq ? { changedSince: folder.highestModseq } : {}) }
        )) {
            changed.set(message.uid, message.flags ?? new Set<string>());
        }
    } catch {
        return;
    }

    for (const row of held) {
        const flags = changed.get(Number(row.uid));
        if (!flags) continue;
        const seen = flags.has("\\Seen");
        const flagged = flags.has("\\Flagged");
        const answered = flags.has("\\Answered");
        if (seen === row.seen && flagged === row.flagged && answered === row.answered) continue;
        await prisma.mailMessage.update({ where: { id: row.id }, data: { seen, flagged, answered } });
    }
}

/**
 * Messages that are no longer there.
 *
 * A uid search over the folder is one command and answers with numbers only, so
 * it is cheap enough to run every pass. Without it a message deleted from a
 * phone stays in this list for ever, which is the single most common complaint
 * about a mail client that caches.
 */
async function reconcileDeletions(client: ImapFlow, folder: FolderRow): Promise<void> {
    const held = await prisma.mailMessage.findMany({
        where: { folderId: folder.id },
        select: { id: true, uid: true },
        orderBy: { uid: "desc" },
        take: WINDOW
    });
    if (held.length === 0) return;

    const first = held[0];
    if (!first) return;
    const lowest = held.reduce((low, row) => (row.uid < low ? row.uid : low), first.uid);
    let present: number[] | false;
    try {
        present = await client.search({ uid: `${lowest}:*` }, { uid: true });
    } catch {
        return;
    }
    if (present === false) return;
    const alive = new Set(present);
    const gone = held.filter((row) => !alive.has(Number(row.uid))).map((row) => row.id);
    if (gone.length === 0) return;
    await prisma.mailMessage.deleteMany({ where: { id: { in: gone } } });
}

/**
 * Every account due a pass, oldest first.
 *
 * Due is decided per account from its own interval, so a mailbox somebody set to
 * check every minute is not held up by twenty that check every ten.
 */
export async function accountsToSync(): Promise<string[]> {
    const accounts = await prisma.mailAccount.findMany({
        where: { state: { not: "auth" } },
        select: { id: true, pollSeconds: true, lastSyncAt: true },
        orderBy: { lastSyncAt: { sort: "asc", nulls: "first" } },
        take: 200
    });
    const now = Date.now();
    return accounts
        .filter(
            (account) =>
                !account.lastSyncAt || now - account.lastSyncAt.getTime() >= account.pollSeconds * 1000
        )
        .map((account) => account.id);
}
