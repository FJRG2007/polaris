/**
 * Noticing that something sent did not arrive.
 *
 * For a mailbox at somebody else's provider this is the only honest evidence of
 * delivery there is. The provider took the message and said 250; everything
 * after that happens between servers Polaris never talks to. The one thing that
 * comes back is a delivery report, and it comes back as a perfectly ordinary
 * message, from `mailer-daemon`, with a subject nobody reads, filed in the inbox
 * next to a newsletter - which is why "I sent it, they never got it, neither of
 * us knew" is the ordinary outcome and not the unusual one.
 *
 * So: a pass over what has arrived, reading each message with
 * `core.readDeliveryReport`, and tying the ones that are reports back to the send
 * they are about. The tying is the careful half, and it is deliberately willing
 * to give up: a report Polaris cannot confidently name a message for changes
 * nothing, and the send stays "accepted, nothing came back", which is true. The
 * failure to avoid at all costs is marking a message that arrived perfectly well
 * as one that bounced.
 *
 * Nothing here reaches for a mail server. Every field it reads was written by a
 * sync onto the message row, so a report is noticed on the pass after the one
 * that brought it in.
 */

import { prisma } from "@polaris/db";
import { stringsFrom } from "./json";
import * as core from "@polaris/core";
import { announceBounce, recipientsOf } from "./delivery";

/** How long a send is still worth matching a report against. Servers retry a
 *  deferred message for days; past two weeks nothing is coming. */
const OPEN_SEND_DAYS = 14;
/** How far back a pass looks for reports. Comfortably more than the gap between
 *  passes, so nothing falls between two of them, and short enough that the read
 *  stays small. */
const ARRIVAL_HOURS = 72;
/** Per mailbox, per pass. A mailbox with more delivery reports than this in
 *  three days has a problem the next pass will carry on with. */
const ARRIVALS_PER_ACCOUNT = 200;
/** Mailboxes per pass, so one Polaris with many of them spreads the work. */
const ACCOUNTS_PER_PASS = 50;

/** Where a report can be found, and what states it can still change. */
const OPEN_STATES = ["accepted", "partial", "delayed"];
/**
 * Folders a report can land in.
 *
 * Junk is included because a bounce from a server nobody has written to before
 * is exactly the shape of thing a filter mistrusts, and a bounce nobody sees is
 * the problem this exists to end - but with a limit worth knowing: sync only
 * brings bodies down for the inbox and the archive, so a report sitting in Junk
 * is read here on the pass after somebody opens it, and not before. Reading it
 * off the subject alone instead would mean deciding a message bounced without
 * having seen the report say so, which is the one thing this must not do.
 */
const REPORT_FOLDERS = ["inbox", "archive", "junk"];

/**
 * One pass. Answers with how many sends a report settled.
 *
 * Idempotent: settling a delivery is a conditional update off the states above,
 * so a report read again on the next pass finds nothing left to move and nobody
 * is told twice.
 */
export async function sweepBounces(): Promise<number> {
    const open = new Date(Date.now() - OPEN_SEND_DAYS * 24 * 60 * 60 * 1000);
    const waiting = await prisma.mailDelivery.findMany({
        where: { state: { in: OPEN_STATES }, sentAt: { gte: open } },
        distinct: ["accountId"],
        orderBy: { sentAt: "desc" },
        take: ACCOUNTS_PER_PASS,
        select: { accountId: true }
    });

    let settled = 0;
    for (const entry of waiting) {
        settled += await sweepAccount(entry.accountId, open).catch((caught) => {
            console.error("polaris: a mailbox's delivery reports could not be read:", caught);
            return 0;
        });
    }
    return settled;
}

async function sweepAccount(accountId: string, open: Date): Promise<number> {
    const sends = await prisma.mailDelivery.findMany({
        where: { accountId, state: { in: OPEN_STATES }, sentAt: { gte: open } },
        select: { id: true, messageId: true, subject: true, toJson: true, state: true }
    });
    if (sends.length === 0) return 0;

    const arrivals = await prisma.mailMessage.findMany({
        where: {
            accountId,
            createdAt: { gte: new Date(Date.now() - ARRIVAL_HOURS * 60 * 60 * 1000) },
            deleted: false,
            folder: { role: { in: REPORT_FOLDERS } }
        },
        orderBy: { createdAt: "desc" },
        take: ARRIVALS_PER_ACCOUNT,
        select: {
            id: true,
            threadId: true,
            subject: true,
            fromJson: true,
            inReplyTo: true,
            references: true,
            headers: true,
            bodyText: true
        }
    });
    if (arrivals.length === 0) return 0;

    const byMessageId = new Map(sends.map((send) => [send.messageId, send]));
    /** Every open send, by each address it went to. An address that two open
     *  sends share names neither of them: a report that only says "this address"
     *  cannot choose between two messages, and guessing would put a bounce on
     *  the wrong conversation. */
    const byRecipient = new Map<string, (typeof sends)[number] | null>();
    for (const send of sends) {
        for (const address of recipientsOf(send.toJson)) {
            byRecipient.set(address, byRecipient.has(address) ? null : send);
        }
    }

    let settled = 0;
    for (const arrival of arrivals) {
        const headers = (arrival.headers as Record<string, string> | null) ?? {};
        const report = core.readDeliveryReport({
            subject: arrival.subject,
            from: senderOf(arrival.fromJson),
            inReplyTo: arrival.inReplyTo,
            references: stringsFrom(arrival.references),
            autoSubmitted: headers["auto-submitted"] ?? "",
            text: arrival.bodyText ?? ""
        });
        if (!report) continue;
        // A report saying it arrived is about somebody else's send: Polaris never
        // asks for one, so nothing here is waiting to hear it, and a message
        // that is already "accepted" learns nothing from it.
        if (report.kind === "delivered") continue;

        const send =
            (report.aboutMessageId ? byMessageId.get(report.aboutMessageId) : undefined) ??
            (report.recipient ? (byRecipient.get(report.recipient) ?? undefined) : undefined);
        if (!send) continue;

        const state = report.kind === "delayed" ? "delayed" : "bounced";
        // Only ever forwards: a delay arriving after a bounce, or a second copy
        // of the same report, finds nothing to move.
        const from = state === "bounced" ? OPEN_STATES : ["accepted", "partial"];
        const moved = await prisma.mailDelivery.updateMany({
            where: { id: send.id, state: { in: from } },
            data: {
                state,
                detail: core.deliveryReportSentence(report),
                detailFor: report.recipient,
                reportThreadId: arrival.threadId,
                settledAt: new Date()
            }
        });
        if (moved.count === 0) continue;
        settled += 1;
        // Said only for a message that is not arriving. A delay is shown on the
        // conversation, where somebody looking at it will see it; a bell for
        // every server that queued a message for an hour is a bell people
        // switch off, and then the bounce goes unseen too.
        if (state === "bounced") {
            await announceBounce(
                accountId,
                send.subject,
                core.deliveryReportSentence(report),
                `/mail/t/${arrival.threadId}`
            ).catch(() => undefined);
        }
    }
    return settled;
}

/** The first From address, lowercased, or "". */
function senderOf(fromJson: unknown): string {
    const first = Array.isArray(fromJson) ? fromJson[0] : null;
    const address = (first as { address?: unknown } | null)?.address;
    return typeof address === "string" ? address.toLowerCase() : "";
}
