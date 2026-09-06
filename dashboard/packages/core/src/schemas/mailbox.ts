/**
 * Everything the Mail app accepts from a browser.
 *
 * A mail client takes more typed input than anything else in Polaris - a host,
 * a port, a password, a list of addresses, a regular expression somebody wrote
 * for a filter - and most of it is then handed to a socket or to another
 * person's mail server. So the shapes are declared once here and used on both
 * sides: the form validates against them as somebody types, and the server
 * validates against them again before anything is opened or sent.
 *
 * The address schema is the one worth reading. It is deliberately not a strict
 * RFC 5322 parser: real mailboxes exist that a strict parser refuses, and a
 * client that will not let somebody write to an address their old client wrote
 * to every day is a broken client. It refuses what cannot be a mailbox and
 * accepts the rest, and the server that has to deliver it is the authority on
 * anything finer.
 */

import { z } from "zod";

/** The trim-then-lowercase every address goes through before it is compared,
 *  stored, or sent. One function so the browser and the server agree on what
 *  "the same address" means. */
export function normalizeMailAddress(value: string): string {
    return value.trim().toLowerCase();
}

/** The display name beside an address, trimmed and stripped of the characters
 *  that would split a header if they reached one. */
export function normalizeMailName(value: string): string {
    return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

export const mailAddress = z
    .string()
    .transform(normalizeMailAddress)
    .pipe(
        z
            .string()
            .min(3, "That is not an email address")
            .max(320)
            // One @ with something either side, no spaces, and a dot in the
            // domain. Everything a mailbox must have and nothing a real one
            // would be refused for.
            .regex(/^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/, "That is not an email address")
    );

export const mailDisplayName = z.string().transform(normalizeMailName).pipe(z.string().max(120));

/** A recipient as the composer holds one. */
export const mailRecipient = z.object({
    name: mailDisplayName.default(""),
    address: mailAddress
});

export const mailRecipientList = z.array(mailRecipient).max(200, "That is more recipients than one message should carry");

export const mailHost = z
    .string()
    .transform((value) => value.trim().toLowerCase())
    .pipe(
        z
            .string()
            .min(1, "Name the server")
            .max(253)
            .regex(/^[a-z0-9._:-]+$/, "That is not a server name")
    );

export const mailPort = z.coerce.number().int().min(1).max(65535);

export const mailSocketSecurity = z.enum(["tls", "starttls", "none"]);

const serverSettings = z.object({
    host: mailHost,
    port: mailPort,
    security: mailSocketSecurity
});

/**
 * How an account proves who it is.
 *
 * `oauth` names a linked account the person already authorized, so no secret is
 * typed here at all and none is stored beyond the one the connection already
 * holds. `password` is everything else, and on most of the big services that
 * means an app password rather than the sign-in one.
 */
export const mailAuthKind = z.enum(["password", "oauth"]);

/** Adding an account the manual way: the person typed the servers, or Polaris
 *  worked them out and they accepted them. */
export const mailAccountSetupSchema = z
    .object({
        address: mailAddress,
        /** What the sender line says. Blank falls back to the Polaris profile
         *  name, which is what somebody would have typed anyway. */
        displayName: mailDisplayName.default(""),
        /** What to call it in the rail when somebody has three. Blank is the
         *  address. */
        label: z.string().transform(normalizeMailName).pipe(z.string().max(60)).default(""),
        auth: mailAuthKind,
        /** The linked account authorizing this, for `oauth`. */
        connectionId: z.string().uuid().nullable().default(null),
        /** The mailbox password or app password, for `password`. Never returned
         *  by any read. */
        password: z.string().min(1).max(1024).optional(),
        /** The login the servers expect, where it is not the address. Plenty of
         *  hosting panels use a separate one. */
        username: z.string().trim().max(320).default(""),
        imap: serverSettings,
        smtp: serverSettings,
        /** The provider slug this was recognised as, for the settings that
         *  differ per service. Empty for a server nobody recognised. */
        provider: z.string().trim().max(40).default("")
    })
    .superRefine((value, context) => {
        if (value.auth === "password" && !value.password) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["password"],
                message: "Enter the password for this mailbox"
            });
        }
        if (value.auth === "oauth" && !value.connectionId) {
            context.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["connectionId"],
                message: "Choose the authorized account this mailbox belongs to"
            });
        }
    });

export type MailAccountSetup = z.infer<typeof mailAccountSetupSchema>;

/** Asking Polaris where an address's mail lives, before any password is typed. */
export const mailDiscoverySchema = z.object({ address: mailAddress });

/** What can be changed about an account after it exists. Servers and credentials
 *  are changed by reconnecting it, not edited in place: a half-changed account
 *  is one that syncs against one server and sends through another. */
export const mailAccountEditSchema = z.object({
    displayName: mailDisplayName.default(""),
    label: z.string().transform(normalizeMailName).pipe(z.string().max(60)).default(""),
    /** The dot beside it in the rail. */
    color: z
        .string()
        .trim()
        .regex(/^#[0-9a-fA-F]{6}$/, "That is not a color")
        .nullable()
        .default(null),
    /** Whether new mail here is announced. Off for the account somebody keeps
     *  only to read a newsletter in. */
    notify: z.boolean().default(true),
    /** How often the server is asked, in seconds, when it does not push. */
    pollSeconds: z.coerce.number().int().min(60).max(3600).default(300),
    /** Whether this account's mail appears in the unified views. */
    unified: z.boolean().default(true),
    /** Whether a copy of what is sent is filed into Sent by Polaris. Off for the
     *  services that file it themselves, or the mailbox ends up with two. */
    appendToSent: z.boolean().default(true),
    signature: z.string().max(20000).default(""),
    /** Whether the signature goes above the quoted history or below it. Above is
     *  what everybody expects; below is what a mailing list expects. */
    signatureAboveQuote: z.boolean().default(true)
});

/** The out-of-office reply. Off means the fields are kept and nothing is sent. */
export const mailVacationSchema = z
    .object({
        enabled: z.boolean().default(false),
        subject: z.string().trim().max(200).default(""),
        body: z.string().max(20000).default(""),
        startsAt: z.coerce.date().nullable().default(null),
        endsAt: z.coerce.date().nullable().default(null),
        /** How long before the same person is answered again. Days, because an
         *  hour turns a mailing list into an argument. */
        repeatDays: z.coerce.number().int().min(1).max(90).default(7)
    })
    .superRefine((value, context) => {
        if (value.enabled && !value.body.trim()) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["body"], message: "Write what it should say" });
        }
        if (value.startsAt && value.endsAt && value.endsAt <= value.startsAt) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["endsAt"], message: "It has to end after it starts" });
        }
    });

/** A second address the same mailbox may send from. */
export const mailIdentitySchema = z.object({
    address: mailAddress,
    displayName: mailDisplayName.default(""),
    replyTo: z.union([mailAddress, z.literal("")]).default(""),
    signature: z.string().max(20000).default(""),
    isDefault: z.boolean().default(false)
});

/* -------------------------------------------------------------------------- */
/* Composing                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The most one attachment may be.
 *
 * Twenty-five megabytes is what the large services accept, and refusing to send
 * something the recipient's server would have taken is worse than a refusal
 * somebody understands. Anything bigger belongs in Drive with a link.
 *
 * Declared here rather than beside the upload code so the composer can say so
 * before a file is chosen: a limit only the server knows is a limit somebody
 * finds out about after waiting for an upload.
 */
export const MAIL_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** A file already uploaded and waiting to be attached, by its id. */
const attachmentIds = z.array(z.string().uuid()).max(50);

export const mailComposeSchema = z
    .object({
        accountId: z.string().uuid(),
        /** Which of the account's addresses this is sent from. Absent is the
         *  account's own. */
        identityId: z.string().uuid().nullable().default(null),
        to: mailRecipientList,
        cc: mailRecipientList.default([]),
        bcc: mailRecipientList.default([]),
        replyTo: z.union([mailAddress, z.literal("")]).default(""),
        subject: z.string().transform(normalizeMailName).pipe(z.string().max(500)).default(""),
        /** The message as Markdown, which is what every editor in Polaris
         *  produces. It becomes both the HTML part and, stripped, the text one. */
        body: z.string().max(1_000_000).default(""),
        attachmentIds: attachmentIds.default([]),
        /** The message being replied to, so the headers can name it and the
         *  conversation stays one conversation. */
        inReplyToId: z.string().uuid().nullable().default(null),
        /** True when this is a forward rather than a reply, which changes only
         *  what the quoted part says. */
        forward: z.boolean().default(false),
        /** When to send it. Null is now. */
        sendAt: z.coerce.date().nullable().default(null),
        /** Ask for a read receipt. Off by default and stays that way unless
         *  somebody deliberately turns it on: it is the thing this app blocks
         *  other people from doing. */
        requestReceipt: z.boolean().default(false),
        /** The draft this replaces, so sending it clears the saved copy. */
        draftId: z.string().uuid().nullable().default(null)
    })
    .superRefine((value, context) => {
        if (value.to.length + value.cc.length + value.bcc.length === 0) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["to"], message: "Say who it goes to" });
        }
        if (value.sendAt && value.sendAt.getTime() < Date.now() - 60_000) {
            context.addIssue({ code: z.ZodIssueCode.custom, path: ["sendAt"], message: "That time has passed" });
        }
    });

export type MailCompose = z.infer<typeof mailComposeSchema>;

/** A draft on its way to being saved. Everything is optional because a draft is
 *  saved constantly and is nearly always incomplete. */
export const mailDraftSchema = z.object({
    id: z.string().uuid().nullable().default(null),
    accountId: z.string().uuid(),
    identityId: z.string().uuid().nullable().default(null),
    to: mailRecipientList.default([]),
    cc: mailRecipientList.default([]),
    bcc: mailRecipientList.default([]),
    replyTo: z.union([mailAddress, z.literal("")]).default(""),
    subject: z.string().transform(normalizeMailName).pipe(z.string().max(500)).default(""),
    body: z.string().max(1_000_000).default(""),
    attachmentIds: attachmentIds.default([]),
    inReplyToId: z.string().uuid().nullable().default(null),
    forward: z.boolean().default(false),
    sendAt: z.coerce.date().nullable().default(null),
    requestReceipt: z.boolean().default(false)
});

/* -------------------------------------------------------------------------- */
/* Acting on messages                                                          */
/* -------------------------------------------------------------------------- */

export const mailMessageAction = z.enum([
    "read",
    "unread",
    "star",
    "unstar",
    "archive",
    "trash",
    "delete",
    "junk",
    "not-junk",
    "inbox"
]);

/** Anything done to a set of messages at once. The list is capped because every
 *  one of them is a round trip to somebody's mail server. */
export const mailActionSchema = z.object({
    messageIds: z.array(z.string().uuid()).min(1).max(500),
    action: mailMessageAction
});

export const mailMoveSchema = z.object({
    messageIds: z.array(z.string().uuid()).min(1).max(500),
    folderId: z.string().uuid()
});

export const mailSnoozeSchema = z.object({
    messageIds: z.array(z.string().uuid()).min(1).max(500),
    /** Null wakes it now. */
    until: z.coerce.date().nullable()
});

export const mailLabelSchema = z.object({
    name: z
        .string()
        .transform(normalizeMailName)
        .pipe(z.string().min(1, "Give it a name").max(60)),
    color: z
        .string()
        .trim()
        .regex(/^#[0-9a-fA-F]{6}$/, "That is not a color")
        .default("#6366f1")
});

export const mailLabelApplySchema = z.object({
    messageIds: z.array(z.string().uuid()).min(1).max(500),
    labelId: z.string().uuid(),
    applied: z.boolean()
});

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export const mailRuleField = z.enum(["from", "to", "recipient", "subject", "body", "list", "attachment", "size"]);

export const mailRuleOperator = z.enum([
    "contains",
    "not-contains",
    "is",
    "is-not",
    "starts-with",
    "ends-with",
    "matches",
    "greater-than",
    "less-than"
]);

export const mailRuleConditionSchema = z.object({
    field: mailRuleField,
    operator: mailRuleOperator,
    value: z.string().trim().min(1, "Say what to look for").max(500)
});

export const mailRuleActionSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("move"), folder: z.string().uuid() }),
    z.object({ kind: z.literal("label"), label: z.string().uuid() }),
    z.object({ kind: z.literal("star") }),
    z.object({ kind: z.literal("read") }),
    z.object({ kind: z.literal("archive") }),
    z.object({ kind: z.literal("trash") }),
    z.object({ kind: z.literal("junk") }),
    z.object({ kind: z.literal("pin") }),
    z.object({ kind: z.literal("mute") })
]);

export const mailRuleSchema = z.object({
    name: z
        .string()
        .transform(normalizeMailName)
        .pipe(z.string().min(1, "Give the rule a name").max(80)),
    enabled: z.boolean().default(true),
    match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(mailRuleConditionSchema).min(1, "Add something to match on").max(20),
    actions: z.array(mailRuleActionSchema).min(1, "Say what should happen").max(10),
    stop: z.boolean().default(false),
    /** Whether it also runs over what is already in the mailbox, once. */
    applyToExisting: z.boolean().default(false)
});

/* -------------------------------------------------------------------------- */
/* Reading and searching                                                       */
/* -------------------------------------------------------------------------- */

export const mailSearchSchema = z.object({
    query: z.string().trim().max(500).default(""),
    accountId: z.string().uuid().nullable().default(null),
    folderId: z.string().uuid().nullable().default(null),
    labelId: z.string().uuid().nullable().default(null),
    unreadOnly: z.boolean().default(false),
    starredOnly: z.boolean().default(false),
    withAttachments: z.boolean().default(false),
    from: z.string().trim().max(320).default(""),
    to: z.string().trim().max(320).default(""),
    since: z.coerce.date().nullable().default(null),
    before: z.coerce.date().nullable().default(null),
    /** Whether to ask the mail server as well as the copy Polaris holds. Slower,
     *  and the only way to reach a message older than the sync window. */
    onServer: z.boolean().default(false),
    cursor: z.string().trim().max(200).default(""),
    limit: z.coerce.number().int().min(1).max(100).default(50)
});

export type MailSearch = z.infer<typeof mailSearchSchema>;

/** Letting one sender's images through from now on, or taking that back. */
export const mailTrustSenderSchema = z.object({
    address: mailAddress,
    trusted: z.boolean()
});

/** How remote content is treated for everybody's mail on this account. */
export const mailRemoteContentMode = z.enum(["block", "trusted", "always"]);

export const mailPrivacySchema = z.object({
    remoteContent: mailRemoteContentMode.default("trusted"),
    /** Whether a message's trackers are named above it rather than only counted. */
    nameTrackers: z.boolean().default(true),
    /** Whether a read receipt anybody asks for is ever answered. Off, and there
     *  is no per-message override: a client that sometimes answers them is a
     *  client that has told the sender their address is live. */
    answerReceipts: z.boolean().default(false),
    /** Whether links are stripped of the parameters that identify the reader. */
    cleanLinks: z.boolean().default(true)
});

export type MailPrivacy = z.infer<typeof mailPrivacySchema>;
