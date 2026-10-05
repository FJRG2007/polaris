/**
 * Mail, as tools an agent can call.
 *
 * Mail is part of every Polaris rather than an app somebody installs, so its
 * tools are core's. They read and send through the same modules the Mail
 * screens do - `lib/mailbox/access` decides whether a mailbox, folder or
 * message is this account's, `lib/mailbox/views` and `open` read, `compose`
 * queues - so a mailbox somebody else linked is one their assistant cannot
 * reach either. Only the person who linked a mailbox can: there is no
 * administrator override here, as there is none on the screens.
 *
 * Reading and sending are separate scopes, and sending is never ticked for
 * anybody: an assistant that writes to people outside Polaris in somebody's
 * name is a decision they make on purpose. A sent message waits out the
 * person's own undo window like one sent from the screen, so it can still be
 * taken back from the Outbox.
 *
 * Deliberately not offered: deleting, moving or marking messages, and
 * attachments. Each is a click in the screen.
 */

import { z } from "zod";
import * as core from "@polaris/core";
import { McpRefusal, type McpTool, defineMcpTool } from "../protocol";

/** Loaded when a tool runs: the mail modules reach IMAP and SMTP clients that
 *  listing the tools has no need of. */
async function services() {
    const [access, shelf, accounts, views, open, compose] = await Promise.all([
        import("@/lib/mailbox/access"),
        import("@/lib/mailbox/shelf"),
        import("@/lib/mailbox/accounts"),
        import("@/lib/mailbox/views"),
        import("@/lib/mailbox/open"),
        import("@/lib/mailbox/compose")
    ]);
    return { access, shelf, accounts, views, open, compose };
}

/**
 * Run a mail operation, turning the refusals written for the person - not
 * theirs, the server could not be reached, the password was refused - into
 * ones the model reads. Their sentences name nothing internal.
 */
async function attempt<T>(run: () => Promise<T>): Promise<T> {
    try {
        return await run();
    } catch (caught) {
        const [{ MailAccessError }, { MailAuthError }, { MailUnreachableError }] =
            await Promise.all([
                import("@/lib/mailbox/access"),
                import("@/lib/mailbox/credentials"),
                import("@/lib/mailbox/imap")
            ]);
        if (
            caught instanceof MailAccessError ||
            caught instanceof MailAuthError ||
            caught instanceof MailUnreachableError
        )
            throw new McpRefusal(caught.message);
        throw caught;
    }
}

/** How much of one message a read returns. */
const BODY_LIMIT = 50_000;

const accountId = z.string().uuid().describe("The mailbox's id, as mail_mailboxes returned it.");

function addressLine(addresses: readonly core.MailAddress[]): string {
    return addresses
        .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address))
        .join(", ");
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const mailboxesTool = defineMcpTool({
    name: "mail_mailboxes",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List mailboxes",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The mailboxes this account linked in Polaris, with their ids and addresses. Use an id with mail_list or mail_send.",
    input: z.object({}),
    // Either is enough: a mailbox to send from has to be named as much as one
    // to read.
    scope: ["mail.read", "mail.send"],
    readOnly: true,
    async run(_input, caller) {
        const { accounts, shelf } = await services();
        // Every mailbox, whichever organization's shelf it sits on: a call has
        // no screen whose shelf it could be looking at.
        const rows = await accounts.listAccountViews(caller.userId, shelf.EVERY_SHELF);
        const items = rows.map((row) => ({
            id: row.id,
            address: row.address,
            name: row.displayName || row.label || "",
            state: row.state
        }));
        if (items.length === 0) {
            return { text: "No mailboxes are linked yet.", structured: { mailboxes: [] } };
        }
        return {
            text: items
                .map((item) => `${item.id}  ${item.address}${item.name ? ` (${item.name})` : ""}`)
                .join("\n"),
            structured: { mailboxes: items }
        };
    }
});

const listInput = z.object({
    accountId: accountId
        .optional()
        .describe(
            "One mailbox, as mail_mailboxes returned it. Absent is the mailboxes the person reads together in the unified views."
        ),
    folder: z
        .enum(["inbox", "sent", "drafts", "archive", "junk", "trash"])
        .default("inbox")
        .describe("Which folder to read."),
    query: z
        .string()
        .trim()
        .max(300)
        .default("")
        .describe(
            "Search words, as the Mail search box takes them (from:, subject:, has:attachment). Empty lists the folder."
        ),
    unreadOnly: z.boolean().default(false).describe("Only conversations with unread mail."),
    cursor: z
        .string()
        .max(500)
        .default("")
        .describe("Where the previous page ended: send back its nextCursor."),
    limit: z.number().int().min(1).max(50).default(20).describe("How many conversations.")
});

const listTool = defineMcpTool({
    name: "mail_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List or search mail",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Conversations in one folder of this account's mail, newest first, optionally searched. Returns subjects, senders and a snippet; read a message with mail_read and its messageId.",
    input: listInput,
    scope: "mail.read",
    readOnly: true,
    async run(input, caller) {
        const { access, shelf, views } = await services();
        // The list itself takes a mailbox on trust, as the screen that opens it
        // checked first; so is this.
        if (input.accountId)
            await attempt(() => access.ownedAccount(caller.userId, input.accountId!));
        const page = await views.listThreads(
            caller.userId,
            {
                ...views.EMPTY_QUERY,
                accountId: input.accountId ?? null,
                role: input.folder,
                query: input.query,
                unreadOnly: input.unreadOnly,
                cursor: input.cursor,
                limit: input.limit
            },
            shelf.EVERY_SHELF
        );
        const items = page.threads.map((thread) => ({
            messageId: thread.leadMessageId,
            accountId: thread.accountId,
            subject: thread.subject,
            from: addressLine(thread.participants),
            snippet: thread.snippet,
            unread: thread.unreadCount > 0,
            messages: thread.messageCount,
            at: thread.lastMessageAt
        }));
        const nextCursor = page.cursor || null;
        if (items.length === 0) {
            return {
                text: input.query ? "Nothing matches." : "Nothing here.",
                structured: { items, nextCursor }
            };
        }
        return {
            text:
                items
                    .map(
                        (item) =>
                            `${item.messageId}  ${item.at.slice(0, 16)}  ${item.unread ? "* " : ""}${item.from} - ${item.subject}`
                    )
                    .join("\n") +
                (nextCursor ? `\n(more: call again with cursor ${nextCursor})` : ""),
            structured: { items, nextCursor }
        };
    }
});

const readInput = z.object({
    messageId: z.string().uuid().describe("The message's id, as mail_list returned it.")
});

const readTool = defineMcpTool({
    name: "mail_read",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a message",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "One message of this account's mail: who sent it, to whom, when, and its text. Reading it here does not mark it read.",
    input: readInput,
    scope: "mail.read",
    readOnly: true,
    async run(input, caller) {
        const { open } = await services();
        const opened = await attempt(() => open.openMessage(caller.userId, input.messageId));
        if (!opened) throw new McpRefusal("That message is no longer there.");
        const { envelope, readable } = opened;
        // A message sent only as HTML has no text part; its words are read out
        // of the markup the way the list's snippets are.
        const whole = readable.text.trim() || core.snippetFrom(readable.html, BODY_LIMIT);
        const text = whole.slice(0, BODY_LIMIT);
        const cut = whole.length > BODY_LIMIT;
        return {
            text: [
                `From: ${addressLine(envelope.from)}`,
                `To: ${addressLine(envelope.to)}`,
                ...(envelope.cc.length > 0 ? [`Cc: ${addressLine(envelope.cc)}`] : []),
                `Date: ${envelope.sentAt}`,
                `Subject: ${envelope.subject}`,
                "",
                text,
                ...(cut
                    ? ["", "(The message continues; open it in Polaris to read the rest.)"]
                    : [])
            ].join("\n"),
            structured: {
                id: envelope.id,
                accountId: envelope.accountId,
                subject: envelope.subject,
                from: envelope.from,
                to: envelope.to,
                cc: envelope.cc,
                sentAt: envelope.sentAt,
                text,
                truncated: cut
            }
        };
    }
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const recipients = z.array(z.string().trim().max(320)).max(50).default([]);

const sendInput = z.object({
    accountId: accountId.describe("The mailbox to send from, as mail_mailboxes returned it."),
    to: recipients.describe("Addresses to send to."),
    cc: recipients.describe("Addresses to copy."),
    subject: z.string().max(500).default("").describe("The subject line."),
    body: z.string().max(100_000).describe("The message, as plain text or Markdown."),
    inReplyToId: z
        .string()
        .uuid()
        .optional()
        .describe(
            "The message this answers, as mail_list returned it, to keep the conversation together."
        )
});

const sendTool = defineMcpTool({
    name: "mail_send",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Send a message",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Send an email from one of this account's mailboxes, in its name. It goes after the account's undo delay and can be taken back from the Outbox until then. Confirm the recipients and the text with the person before sending.",
    input: sendInput,
    scope: "mail.send",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const { compose } = await services();
        // The composer's own schema: addresses normalized and checked, at least
        // one recipient, the subject's and the body's limits.
        const parsed = core.mailComposeSchema.safeParse({
            accountId: input.accountId,
            to: input.to.map((address) => ({ address })),
            cc: input.cc.map((address) => ({ address })),
            subject: input.subject,
            body: input.body,
            inReplyToId: input.inReplyToId ?? null
        });
        if (!parsed.success) {
            const first = parsed.error.issues[0];
            throw new McpRefusal(
                `${first?.path.join(".") || "message"}: ${first?.message ?? "not a message that can be sent"}`
            );
        }
        const message = parsed.data;
        const queued = await attempt(() =>
            compose.queueSend(caller.userId, {
                accountId: message.accountId,
                // The mailbox's own address: choosing another identity is the
                // screen's to offer.
                identityId: null,
                to: message.to,
                cc: message.cc,
                bcc: [],
                replyTo: "",
                subject: message.subject,
                body: message.body,
                attachmentIds: [],
                inReplyToId: message.inReplyToId,
                forward: false,
                sendAt: null,
                requestReceipt: false,
                draftId: null
            })
        );
        return {
            text: `Queued. It goes at ${queued.sendAt.toISOString()} unless it is taken back from the Outbox.`,
            structured: { draftId: queued.draftId, sendAt: queued.sendAt.toISOString() }
        };
    }
});

export const MAIL_TOOLS: McpTool<never>[] = [mailboxesTool, listTool, readTool, sendTool];
