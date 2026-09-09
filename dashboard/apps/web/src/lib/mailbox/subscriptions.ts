/**
 * What a mailbox is subscribed to, and getting out of it.
 *
 * Two halves, and the first one is why the second is possible at all.
 *
 * **The registry.** Every message that publishes a way out writes one row for
 * its sender as it arrives - see `recordSubscription`, called from the sync for
 * mail that is new and from the body fetch for the senders whose only way out is
 * in their footer. Nothing here scans a mailbox on demand: the offer lives in
 * the headers of every message and in the markup of the ones that carry no
 * header, so answering "what am I subscribed to" by reading the mail would mean
 * fetching a few hundred bodies while somebody watches a spinner. What is stored
 * is what was found, and the screen is one indexed read.
 *
 * **The way out.** Three of them, and only one is instant:
 *
 * - `one-click` - the sender published `List-Unsubscribe-Post`, which per
 *   RFC 8058 means a POST of `List-Unsubscribe=One-Click` to their address takes
 *   the reader off the list. Done from here, through the same guarded fetch
 *   everything else that reaches an address somebody else supplied goes through:
 *   an unsubscribe link is a person-supplied URL fetched by the server, which is
 *   a request forgery if it is not checked.
 * - `mailto` - the way out is a message. Polaris sends it from the mailbox that
 *   received the mail, because the alternative is handing a `mailto:` link to a
 *   browser that has nothing to open it with. The subject the sender named is
 *   carried through: it is how the robot at the other end knows which list and
 *   which subscriber, and a message sent without it does nothing.
 * - `link` - a page, opened in the reader's own tab. Nothing else is honest: the
 *   page may want a confirmation, a login, or a set of checkboxes, and a server
 *   that fetched it would learn nothing and change nothing.
 *
 * The row is marked either way, and the screen words it by what actually
 * happened rather than claiming an unsubscribe it cannot know about. Mail
 * arriving after that is not an error to hide - it is the one fact that says a
 * list ignored the request, and it is what turns the row into an offer to block
 * the sender instead.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { addressesFrom } from "./json";
import { composeMime, sendMime } from "./send";
import { follow, safeUrl } from "@/lib/safe-fetch";
import { MailAccessError, ownedAccount, ownedAccountIds } from "./access";

/** One sender, as the screen draws it. */
export interface MailSubscriptionView {
    readonly id: string;
    readonly accountId: string;
    readonly sender: string;
    readonly senderName: string;
    readonly listId: string;
    /** What can be done about it from here. */
    readonly kind: core.UnsubscribeOffer["kind"];
    /** A header is a promise the sender published; a link found in a footer is a
     *  guess Polaris made, and the screen says so. */
    readonly source: core.UnsubscribeOffer["source"];
    readonly url: string;
    readonly messageCount: number;
    readonly lastMessageAt: string;
    /** Empty until somebody asked to be taken off. */
    readonly askedAt: string;
    /** Mail that arrived after the request. The list ignored it. */
    readonly stillSending: boolean;
}

/** What one attempt did. */
export interface UnsubscribeOutcome {
    readonly kind: core.UnsubscribeOffer["kind"];
    /** True only when the sender was actually told - a one-click POST they
     *  accepted, or a message Polaris sent. A page somebody has to finish is
     *  never this. */
    readonly done: boolean;
    /** The page for the reader to open, where finishing it is theirs to do. */
    readonly open: string;
}

/** Raised when there is nothing to act on. Held apart from the access errors so
 *  the screen can say which of the two happened. */
export class MailSubscriptionMissing extends Error {
    public constructor(message = "This sender no longer publishes a way to unsubscribe.") {
        super(message);
        this.name = "MailSubscriptionMissing";
    }
}

/* -------------------------------------------------------------------------- */
/* Recording                                                                   */
/* -------------------------------------------------------------------------- */

/** One message, as much of it as this needs. */
export interface SubscriptionSighting {
    readonly from: readonly core.MailAddress[];
    readonly headers: Readonly<Record<string, string>> | null;
    readonly html?: string;
    readonly text?: string;
    readonly listId?: string;
    readonly at: Date;
    /** Whether this is mail arriving rather than mail being re-read. Only an
     *  arrival counts towards how much a sender sends, or a resync would make
     *  every list look twice as busy as it is. */
    readonly counts: boolean;
}

/**
 * Note what a message says about getting off its list.
 *
 * Silent about everything: called from the sync loop and from the body fetch,
 * neither of which should fail over a bookkeeping row. A sender who publishes no
 * way out writes nothing at all - the registry is the senders somebody can
 * actually leave, not every address that has ever written.
 *
 * A header offer replaces one found in a body, never the other way round. The
 * header is what the sender published; the footer link is Polaris' reading of
 * their markup, and the reading must not overwrite the promise.
 */
export async function recordSubscription(
    accountId: string,
    sighting: SubscriptionSighting
): Promise<void> {
    try {
        const sender = sighting.from[0]?.address?.trim().toLowerCase() ?? "";
        if (!sender.includes("@")) return;

        const offer = core.unsubscribeOffer(
            sighting.headers,
            sighting.html ?? "",
            sighting.text ?? ""
        );
        if (!offer) return;

        const existing = await prisma.mailSubscription.findUnique({
            where: { accountId_sender: { accountId, sender } },
            select: { id: true, source: true, lastMessageAt: true }
        });

        if (!existing) {
            await prisma.mailSubscription.create({
                data: {
                    accountId,
                    sender,
                    senderName: sighting.from[0]?.name ?? "",
                    listId: sighting.listId ?? sighting.headers?.["list-id"] ?? "",
                    url: offer.url,
                    kind: offer.kind,
                    source: offer.source,
                    messageCount: 1,
                    lastMessageAt: sighting.at,
                    firstSeenAt: sighting.at
                }
            });
            return;
        }

        const better = offer.source === "header" || existing.source === "body";
        await prisma.mailSubscription.update({
            where: { id: existing.id },
            data: {
                ...(sighting.from[0]?.name ? { senderName: sighting.from[0].name } : {}),
                ...(better ? { url: offer.url, kind: offer.kind, source: offer.source } : {}),
                ...(sighting.counts ? { messageCount: { increment: 1 } } : {}),
                ...(sighting.counts && sighting.at > existing.lastMessageAt
                    ? { lastMessageAt: sighting.at }
                    : {})
            }
        });
    } catch {
        // A row that did not get written is a row the next message from that
        // sender writes. Nothing above this is worth failing for it.
    }
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/** Everything this shelf's mailboxes are subscribed to, busiest sender last
 *  heard from first. */
export async function listSubscriptions(
    userId: string,
    shelfOrgId: string | null
): Promise<MailSubscriptionView[]> {
    const accountIds = await ownedAccountIds(userId, shelfOrgId);
    if (accountIds.length === 0) return [];

    const rows = await prisma.mailSubscription.findMany({
        where: { accountId: { in: accountIds } },
        orderBy: { lastMessageAt: "desc" }
    });
    return rows.map(asView);
}

function asView(row: {
    id: string;
    accountId: string;
    sender: string;
    senderName: string;
    listId: string;
    kind: string;
    source: string;
    url: string;
    messageCount: number;
    lastMessageAt: Date;
    unsubscribedAt: Date | null;
}): MailSubscriptionView {
    return {
        id: row.id,
        accountId: row.accountId,
        sender: row.sender,
        senderName: row.senderName,
        listId: row.listId,
        kind: row.kind === "one-click" || row.kind === "mailto" ? row.kind : "link",
        source: row.source === "body" ? "body" : "header",
        url: row.url,
        messageCount: row.messageCount,
        lastMessageAt: row.lastMessageAt.toISOString(),
        askedAt: row.unsubscribedAt?.toISOString() ?? "",
        stillSending: row.unsubscribedAt !== null && row.lastMessageAt > row.unsubscribedAt
    };
}

/* -------------------------------------------------------------------------- */
/* Leaving                                                                     */
/* -------------------------------------------------------------------------- */

/** Get off one sender's list, from the screen that lists them. */
export async function unsubscribeFromSender(
    userId: string,
    subscriptionId: string
): Promise<UnsubscribeOutcome> {
    const row = await prisma.mailSubscription.findFirst({
        where: { id: subscriptionId, account: { userId } },
        select: { id: true, accountId: true, url: true, kind: true }
    });
    if (!row) throw new MailAccessError("That subscription is not yours.");
    if (!row.url) throw new MailSubscriptionMissing();

    const account = await ownedAccount(userId, row.accountId);
    const outcome = await perform(account, { url: row.url, kind: kindOf(row.kind) });
    await prisma.mailSubscription.update({
        where: { id: row.id },
        data: { unsubscribedAt: new Date() }
    });
    return outcome;
}

/**
 * Get off the list this message came from.
 *
 * The message is the source rather than the registry, because this is the button
 * on an open message and it has to work on mail that arrived before any of this
 * existed - there is no row for it, and the reader is looking straight at the
 * footer that says there is a way out. The row is written on the way through, so
 * the sender appears on the subscriptions screen from then on.
 */
export async function unsubscribeFromMessage(
    userId: string,
    messageId: string
): Promise<UnsubscribeOutcome> {
    const message = await prisma.mailMessage.findFirst({
        where: { id: messageId, account: { userId } },
        select: {
            accountId: true,
            headers: true,
            fromJson: true,
            listId: true,
            bodyHtml: true,
            bodyText: true,
            sentAt: true
        }
    });
    if (!message) throw new MailAccessError("That message is not yours.");

    const headers = (message.headers as Record<string, string> | null) ?? null;
    const offer = core.unsubscribeOffer(
        headers,
        message.bodyHtml ?? "",
        message.bodyText ?? ""
    );
    if (!offer) throw new MailSubscriptionMissing();

    const from = addressesFrom(message.fromJson);
    const account = await ownedAccount(userId, message.accountId);
    const outcome = await perform(account, offer);

    await recordSubscription(message.accountId, {
        from,
        headers,
        html: message.bodyHtml ?? "",
        text: message.bodyText ?? "",
        listId: message.listId,
        at: message.sentAt,
        counts: false
    });
    const sender = from[0]?.address?.trim().toLowerCase() ?? "";
    if (sender) {
        await prisma.mailSubscription.updateMany({
            where: { accountId: message.accountId, sender },
            data: { unsubscribedAt: new Date() }
        });
    }
    return outcome;
}

function kindOf(value: string): core.UnsubscribeOffer["kind"] {
    return value === "one-click" || value === "mailto" ? value : "link";
}

/** Do whatever this offer allows, and say what was actually done. */
async function perform(
    account: Awaited<ReturnType<typeof ownedAccount>>,
    offer: { url: string; kind: core.UnsubscribeOffer["kind"] }
): Promise<UnsubscribeOutcome> {
    if (offer.kind === "mailto") {
        await sendUnsubscribeMail(account, offer.url);
        return { kind: "mailto", done: true, open: "" };
    }

    if (offer.kind === "one-click" && (await postOneClick(offer.url))) {
        return { kind: "one-click", done: true, open: "" };
    }

    // Either a plain link, or a one-click the sender's own server would not
    // take. Both end the same way: their page, in the reader's tab, where a
    // confirmation button can be pressed by somebody who can see it.
    return { kind: offer.kind, done: false, open: offer.url };
}

/**
 * The RFC 8058 POST.
 *
 * Through the guarded fetch, which is not optional: the address comes off a
 * header written by whoever sent the mail, and an unchecked server-side fetch of
 * it reaches the LAN this machine sits on and the metadata service one address
 * away from a hosted one.
 *
 * Anything but a plainly good answer is treated as "not done", and the caller
 * falls back to opening the page. The mistake worth avoiding is the other one:
 * telling somebody they are off a list they are still on.
 */
async function postOneClick(address: string): Promise<boolean> {
    const url = safeUrl(address);
    if (!url || url.protocol !== "https:") return false;
    const response = await follow(url, "*/*", {
        contentType: "application/x-www-form-urlencoded",
        body: core.ONE_CLICK_BODY
    }).catch(() => null);
    if (!response) return false;
    // Read to the end and drop it. An unread body holds the socket open until it
    // times out, and there is nothing in it anybody here wants.
    await response.body?.cancel().catch(() => undefined);
    return response.status >= 200 && response.status < 300;
}

/**
 * The message a `mailto:` way out asks for, sent from the mailbox that got the
 * mail.
 *
 * It has to come from that address: the robot on the other end recognises a
 * subscriber by the address that writes to it, and a message from anywhere else
 * is one it discards. Nothing is filed in Sent - it is a message to a machine,
 * and somebody's Sent folder is a record of what they wrote.
 */
async function sendUnsubscribeMail(
    account: Awaited<ReturnType<typeof ownedAccount>>,
    address: string
): Promise<void> {
    const wanted = core.unsubscribeMailto(address);
    if (!wanted) throw new MailSubscriptionMissing();

    const from = { name: account.displayName, address: account.address };
    const message = {
        from,
        to: [{ name: "", address: wanted.address }],
        cc: [],
        bcc: [],
        replyTo: "",
        subject: wanted.subject,
        body: wanted.body,
        attachments: [],
        inReplyTo: "",
        references: [],
        requestReceipt: false
    };
    await sendMime(account, message, await composeMime(message));
}
