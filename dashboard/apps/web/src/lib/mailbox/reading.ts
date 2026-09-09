/**
 * Preparing a message to be looked at.
 *
 * The privacy work in this app happens here and in the frame the result is drawn
 * into, and neither is enough on its own:
 *
 * - **Nothing outside is fetched until somebody says so.** Every remote address
 *   in the markup is moved onto a `data-remote-*` attribute before it leaves
 *   this server, so a message cannot tell its sender it was opened. Pressing
 *   "show pictures" puts them back in the browser, with nothing asked of this
 *   server, so even that is one round trip to the sender rather than two.
 * - **The trackers are named.** A message that says "4 blocked, from Mailchimp
 *   and HubSpot" is one people leave the setting on for; a message that says
 *   "some images were blocked" is one they switch it off for on the second day.
 * - **Links lose what identifies the reader.** The address still goes where it
 *   says; it stops carrying who followed it.
 * - **A read receipt is never answered.** It is recorded and shown to the
 *   reader, and that is the whole of what Polaris does with one.
 *
 * The markup itself is made safe in the browser rather than here: it is rendered
 * into a sandboxed frame with no script, no same-origin and a policy that
 * forbids every outside load, and it goes through a sanitizer on the way in. A
 * regular expression here could not be that boundary and is not asked to be -
 * what it does is decide what a message is allowed to want.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { imageUrl } from "./image-token";
import { addressesFrom } from "./json";

/** How remote content is treated. Read off the account. */
export type RemoteContentMode = "block" | "trusted" | "always";

/** A message, ready to be drawn. */
export interface ReadableMessage {
    /** The markup, with remote addresses parked unless they are allowed. */
    readonly html: string;
    readonly text: string;
    /** Whether the pictures are drawn at all. True for every mailbox that has
     *  not been set to block them, because what is drawn goes through Polaris
     *  rather than out of the reader's browser. */
    readonly remoteAllowed: boolean;
    /** How many outside addresses this message carries. */
    readonly remoteCount: number;
    /** The ones that exist to count the reader, with the company where it is
     *  one anybody has heard of. */
    readonly trackers: readonly core.TrackerFinding[];
    /** The companies, once each, for the line above the message. */
    readonly trackerVendors: readonly string[];
    /** Whether this message asked to be told it had been read. */
    readonly wantsReceipt: boolean;
    /** The one-click unsubscribe address the sender published, where they did.
     *  A mailto or an https link, never anything else. */
    readonly unsubscribe: string;
    /** Which of the three ways out it is, so the reading pane can do it rather
     *  than only link to it. "" alongside an empty `unsubscribe`. */
    readonly unsubscribeKind: core.UnsubscribeOffer["kind"] | "";
    /** Whether the sender published it or Polaris read it out of the message.
     *  Carried to the screen because the two are not equally trustworthy: a
     *  header is a promise, and an address found in a body is whatever was
     *  written in a body - including by somebody fishing for a live mailbox. */
    readonly unsubscribeSource: core.UnsubscribeOffer["source"] | "";
}

/** The account settings this reads. */
export interface ReadingPolicy {
    readonly remoteContent: string;
    readonly cleanLinks: boolean;
    readonly nameTrackers: boolean;
}

/**
 * Whether this sender's pictures may load.
 *
 * `trusted` is the default and the one worth defending: nothing loads until the
 * reader says a particular sender is fine, which is a decision about one
 * newsletter rather than about the whole idea. `always` exists because some
 * people do not care and would otherwise be pressing a button on every message.
 */
export async function remoteAllowedFor(
    accountId: string,
    mode: string,
    from: readonly core.MailAddress[]
): Promise<boolean> {
    if (mode === "always") return true;
    if (mode === "block") return false;
    const sender = from[0]?.address;
    if (!sender) return false;
    const trusted = await prisma.mailTrustedSender.findUnique({
        where: { accountId_address: { accountId, address: sender } },
        select: { id: true }
    });
    return Boolean(trusted);
}

/** Every link in the markup, with what identifies the reader taken off. */
function cleanLinks(html: string): string {
    return html.replace(
        /\b(href)\s*=\s*(["'])(https?:\/\/[^"']*)\2/gi,
        (_match, name: string, quote: string, url: string) =>
            `${name}=${quote}${core.cleanLink(url)}${quote}`
    );
}

/**
 * Turn one stored message into something a reading pane can draw.
 *
 * The tracker scan runs against the original markup rather than the held one, so
 * it sees the addresses as the sender wrote them. Held or not, the count is the
 * same: allowing a sender's pictures does not stop Polaris saying what they are.
 */
export async function readableMessage(
    accountId: string,
    /** The message's own id, because the pictures are served back through an
     *  address that names it. */
    messageId: string,
    /** Who is reading, because that address carries a pass and the pass says who
     *  it was made for - the frame it is fetched from has no session to speak of. */
    userId: string,
    policy: ReadingPolicy,
    message: {
        readonly bodyHtml: string | null;
        readonly bodyText: string | null;
        readonly wantsReceipt: boolean;
        readonly headers: unknown;
        readonly fromJson: unknown;
    }
): Promise<ReadableMessage> {
    const from = addressesFrom(message.fromJson);
    const headers = (message.headers as Record<string, string> | null) ?? null;
    const original = message.bodyHtml ?? "";
    const resources = core.remoteResourcesIn(original);
    const trackers = core.trackersIn(resources);
    const allowed = await remoteAllowedFor(accountId, policy.remoteContent, from);

    // Every outside address is pointed at this server rather than at the
    // sender's. The browser fetches from Polaris, Polaris fetches from them, and
    // what a tracking pixel learns is that a server asked - not who read it,
    // from where, on what, or when they opened it.
    //
    // Done to the markup exactly as it is stored, BEFORE anything else touches
    // it. What serves those pictures back has to run the same numbering over the
    // same input to know which address a number meant, and it holds only what is
    // stored - so anything done first here would be a difference it cannot see.
    //
    // A mailbox set to block still blocks: the addresses are held on
    // `data-remote-*` and nothing is fetched at all.
    let html = allowed
        ? core.proxyRemoteContent(original, (index) => imageUrl({ messageId, index, userId }))
        : core.holdRemoteContent(original);
    if (policy.cleanLinks) html = cleanLinks(html);

    // Headers first, then the message's own footer. Plenty of mail that is
    // unmistakably a mailing list publishes no header at all, and its only way
    // out is a link in a sentence - often one that does not contain the word, in
    // a language nobody wrote a matcher for.
    const offer = core.unsubscribeOffer(headers, original, message.bodyText ?? "");

    return {
        html,
        text: message.bodyText ?? "",
        remoteAllowed: allowed,
        remoteCount: resources.length,
        trackers: policy.nameTrackers ? trackers : [],
        trackerVendors: policy.nameTrackers ? core.trackerVendors(trackers) : [],
        wantsReceipt: message.wantsReceipt,
        unsubscribe: offer?.url ?? "",
        unsubscribeKind: offer?.kind ?? "",
        unsubscribeSource: offer?.source ?? ""
    };
}

/** Let this sender's pictures through from now on, or take that back. */
export async function trustSender(
    accountId: string,
    address: string,
    trusted: boolean
): Promise<void> {
    if (trusted) {
        await prisma.mailTrustedSender.upsert({
            where: { accountId_address: { accountId, address } },
            update: {},
            create: { accountId, address }
        });
        return;
    }
    await prisma.mailTrustedSender.deleteMany({ where: { accountId, address } });
}

/** Everybody whose pictures load on this mailbox, for the privacy screen. */
export async function listTrustedSenders(accountId: string): Promise<string[]> {
    const rows = await prisma.mailTrustedSender.findMany({
        where: { accountId },
        select: { address: true },
        orderBy: { address: "asc" }
    });
    return rows.map((row) => row.address);
}
