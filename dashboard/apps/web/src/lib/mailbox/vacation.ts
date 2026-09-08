/**
 * The out-of-office reply.
 *
 * Easy to write and easy to get catastrophically wrong, and the failure is
 * always the same shape: it answers something it should not have, at scale, in
 * public. Every rule below exists because of one of those.
 *
 * - **Never answer a machine.** A bounce, a mailing list, a newsletter, another
 *   auto-reply. `Auto-Submitted` and `Precedence` are the headers written for
 *   exactly this, and a list has a `List-Id`. Answering one is how a vacation
 *   responder ends up in a loop with a mailing list, in front of everybody on it.
 * - **Never answer the same person twice inside the window.** Held in a table
 *   rather than worked out from the mailbox, because the messages this replied
 *   to are in somebody's inbox and may be deleted.
 * - **Never answer a message this mailbox is not actually addressed in.** Being
 *   blind-copied on something is not being written to.
 * - **Say it is automatic.** The reply carries `Auto-Submitted: auto-replied`,
 *   so the client at the other end knows not to answer it back.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { addressesFrom } from "./json";
import { ACCOUNT_COLUMNS } from "./access";
import { composeMime, sendMime } from "./send";

/** Headers that say "a machine sent this". */
function fromMachine(headers: Record<string, string> | null, listId: string): boolean {
    if (listId.trim()) return true;
    const auto = (headers?.["auto-submitted"] ?? "").toLowerCase();
    if (auto && auto !== "no") return true;
    const precedence = (headers?.precedence ?? "").toLowerCase();
    return precedence === "bulk" || precedence === "list" || precedence === "junk";
}

/** Addresses nobody should ever be answered at. */
const NEVER_ANSWERED =
    /^(?:no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?)[+.@-]|^(?:mailer-daemon|postmaster)@/i;

/** Whether the responder is on right now, dates included. */
export function vacationInForce(
    account: {
        vacationEnabled: boolean;
        vacationStartsAt: Date | null;
        vacationEndsAt: Date | null;
    },
    now = new Date()
): boolean {
    if (!account.vacationEnabled) return false;
    if (account.vacationStartsAt && now < account.vacationStartsAt) return false;
    if (account.vacationEndsAt && now > account.vacationEndsAt) return false;
    return true;
}

/**
 * Answer one arriving message, if everything says it should be answered.
 *
 * Returns whether it did, so the caller can count it. Never throws: a vacation
 * reply that fails must not fail the sync that found the message.
 */
export async function replyIfAway(accountId: string, messageId: string): Promise<boolean> {
    const account = await prisma.mailAccount.findUnique({
        where: { id: accountId },
        select: { ...ACCOUNT_COLUMNS, user: { select: { name: true } } }
    });
    if (!account || !vacationInForce(account)) return false;

    const message = await prisma.mailMessage.findUnique({
        where: { id: messageId },
        select: {
            subject: true,
            fromJson: true,
            toJson: true,
            ccJson: true,
            listId: true,
            headers: true,
            messageId: true,
            references: true,
            folder: { select: { role: true } }
        }
    });
    if (!message) return false;

    // Still in the inbox. A message a rule filed, or one the junk filter moved,
    // has already been decided about - and answering junk with an out-of-office
    // is how a mailbox confirms to a sender that the address is real and read.
    // Checked here rather than by each caller in turn: the callers keep growing
    // and every one of them would have to remember.
    if (message.folder.role !== "inbox") return false;

    const from = addressesFrom(message.fromJson)[0];
    if (!from || NEVER_ANSWERED.test(from.address)) return false;
    if (fromMachine(message.headers as Record<string, string> | null, message.listId)) return false;
    // Answering oneself is a loop with one participant.
    if (core.sameAddress(from.address, account.address)) return false;

    // Written TO, not merely copied in on. A blind copy is not a letter.
    const addressed = [...addressesFrom(message.toJson), ...addressesFrom(message.ccJson)];
    if (!addressed.some((entry) => core.sameAddress(entry.address, account.address))) return false;

    const window = new Date(Date.now() - account.vacationRepeatDays * 24 * 60 * 60 * 1000);
    const already = await prisma.mailAutoReply.findUnique({
        where: { accountId_address: { accountId, address: from.address } },
        select: { repliedAt: true }
    });
    if (already && already.repliedAt > window) return false;

    try {
        const self: core.MailAddress = {
            name: account.displayName || account.user.name,
            address: account.address
        };
        const outgoing = {
            from: self,
            to: [from],
            cc: [],
            bcc: [],
            replyTo: "",
            subject: account.vacationSubject.trim() || core.replySubject(message.subject),
            body: account.vacationBody,
            attachments: [],
            inReplyTo: message.messageId ? `<${message.messageId}>` : "",
            references: message.messageId ? [`<${message.messageId}>`] : [],
            requestReceipt: false
        };
        const mime = await composeMime(outgoing);
        // The header that tells the client at the other end this was a machine,
        // so its own responder does not answer back. Added to the built message
        // rather than through the composer, which has no business knowing about
        // vacation replies.
        const marked = Buffer.concat([Buffer.from("Auto-Submitted: auto-replied\r\n"), mime]);
        await sendMime(account, outgoing, marked);
    } catch {
        // Not being able to send an away message is not worth a failed sync, and
        // there is nobody at the keyboard to tell.
        return false;
    }

    await prisma.mailAutoReply.upsert({
        where: { accountId_address: { accountId, address: from.address } },
        update: { repliedAt: new Date() },
        create: { accountId, address: from.address }
    });
    return true;
}
