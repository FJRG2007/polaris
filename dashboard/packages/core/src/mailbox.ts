/**
 * What a mailbox is, worked out rather than fetched.
 *
 * Everything here is pure: given the headers of a message it decides which
 * conversation the message belongs to, what a reply to it is called, what the
 * list should show for it, and which of a person's rules it matches. None of it
 * touches a socket, so all of it can be asserted in a test rather than exercised
 * against somebody's real mail.
 *
 * The one thing worth knowing before changing any of it: a mail client is judged
 * almost entirely on threading. Getting a conversation wrong shows up as a reply
 * that arrives alone in the list, and people notice that long before they notice
 * anything else this file does.
 */

/** One name and address off a header. The name is what the sender wrote, which
 *  is frequently a lie and is never treated as one - it is drawn beside the
 *  address, never instead of it, wherever the difference could matter. */
export interface MailAddress {
    readonly name: string;
    readonly address: string;
}

/** The parts of a message this module reasons about. */
export interface MailEnvelope {
    readonly messageId: string;
    readonly inReplyTo: string;
    /** The References header, already split into ids, oldest first. */
    readonly references: readonly string[];
    readonly subject: string;
    readonly from: readonly MailAddress[];
    readonly to: readonly MailAddress[];
    readonly cc: readonly MailAddress[];
    readonly listId: string;
    readonly sentAt: Date;
}

/**
 * The prefixes a reply or a forward puts in front of a subject, in every
 * language a European mailbox is likely to see one in.
 *
 * Stripping them is what lets a conversation survive somebody replying from a
 * client in another language, which is the ordinary case in any company with an
 * office in two countries. Kept as a pattern rather than a list of two, because
 * "Re: AW: Re: Fwd:" is a real subject line and each layer has to come off.
 */
const REPLY_PREFIX =
    /^\s*(?:(?:re|aw|antw|antwort|sv|vs|vá|odp|ynt|res|r|fwd|fw|wg|tr|rv|enc|doorst|vs|ilt)\s*(?:\[\d+\])?\s*:\s*)+/i;

/** A subject with every reply and forward prefix taken off, collapsed and
 *  lowercased, for comparing two of them. Empty subjects stay empty. */
export function normalizeSubject(subject: string): string {
    return subject.replace(REPLY_PREFIX, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** What a reply to this is called. Already-replied subjects are not stacked. */
export function replySubject(subject: string): string {
    const bare = subject.replace(REPLY_PREFIX, "").trim();
    return bare ? `Re: ${bare}` : "Re:";
}

/** What a forward of this is called. */
export function forwardSubject(subject: string): string {
    const bare = subject.replace(REPLY_PREFIX, "").trim();
    return bare ? `Fwd: ${bare}` : "Fwd:";
}

/**
 * Every message id this message claims to be part of the same conversation as,
 * oldest first and including its own.
 *
 * References is the authoritative answer and In-Reply-To is the fallback for the
 * clients that never learned to write one. Ids are compared with their angle
 * brackets stripped, because half the world writes them and half does not.
 */
export function conversationIds(envelope: MailEnvelope): readonly string[] {
    const seen = new Set<string>();
    const push = (raw: string) => {
        const id = bareMessageId(raw);
        if (id) seen.add(id);
    };
    for (const reference of envelope.references) push(reference);
    push(envelope.inReplyTo);
    push(envelope.messageId);
    return [...seen];
}

/** A message id with the angle brackets and the whitespace taken off. */
export function bareMessageId(raw: string): string {
    return raw.trim().replace(/^<+/, "").replace(/>+$/, "").trim();
}

/**
 * How far apart two messages can be and still be the same conversation when
 * nothing but the subject says so.
 *
 * Subject matching is the fallback for the mailing lists and ticket systems that
 * rewrite headers, and it is the one that goes wrong: "Invoice" from two
 * different companies six months apart is not a conversation. Twenty-eight days
 * is long enough to hold a thread that goes quiet over a holiday and short
 * enough that a recurring subject starts a new one.
 */
export const SUBJECT_THREAD_WINDOW_MS = 28 * 24 * 60 * 60 * 1000;

/** The key a conversation is filed under when its headers name no ancestor.
 *  Never used on its own: it is only reached for after the id match failed. */
export function subjectThreadKey(envelope: MailEnvelope): string | null {
    const subject = normalizeSubject(envelope.subject);
    if (!subject) return null;
    // A mailing list is its own conversation space: two lists can carry the same
    // subject in the same week and they are not the same thread.
    const list = envelope.listId.trim().toLowerCase();
    return list ? `list:${list} ${subject}` : `subject:${subject}`;
}

/**
 * Which of the conversations already on file this message joins.
 *
 * Answered in the order the headers deserve to be believed: an id this message
 * names, then an id that names this message (a reply that arrived before the
 * message it replies to, which happens constantly with mailing lists), then the
 * subject inside the window. Null means it starts one of its own.
 */
export interface ThreadCandidate {
    readonly id: string;
    /** Every message id in the conversation so far, bare. */
    readonly messageIds: readonly string[];
    readonly subjectKey: string | null;
    readonly lastMessageAt: Date;
}

export function threadFor(
    envelope: MailEnvelope,
    candidates: readonly ThreadCandidate[]
): ThreadCandidate | null {
    const ids = new Set(conversationIds(envelope));
    for (const candidate of candidates) {
        if (candidate.messageIds.some((id) => ids.has(id))) return candidate;
    }
    const key = subjectThreadKey(envelope);
    if (!key) return null;
    for (const candidate of candidates) {
        if (candidate.subjectKey !== key) continue;
        const gap = Math.abs(envelope.sentAt.getTime() - candidate.lastMessageAt.getTime());
        if (gap <= SUBJECT_THREAD_WINDOW_MS) return candidate;
    }
    return null;
}

/** An address written the way a header writes it. A name with a comma or a
 *  quote in it is quoted, because otherwise it splits the header in two. */
export function formatAddress(entry: MailAddress): string {
    const name = entry.name.trim();
    if (!name) return entry.address;
    return /[",<>:;@\\[\]]/.test(name)
        ? `"${name.replace(/([\\"])/g, "\\$1")}" <${entry.address}>`
        : `${name} <${entry.address}>`;
}

export function formatAddressList(entries: readonly MailAddress[]): string {
    return entries.map(formatAddress).join(", ");
}

/** What to draw for somebody in a list: their name if they gave one, otherwise
 *  the part of the address before the @, which is closer to a name than the
 *  whole address is. */
export function addressLabel(entry: MailAddress): string {
    const name = entry.name.trim();
    if (name) return name;
    const local = entry.address.split("@")[0] ?? entry.address;
    return local || entry.address;
}

/** Two addresses are the same person when the mailbox is the same, whatever
 *  case either was written in. Sub-addressing is deliberately kept: `a+news@`
 *  is how somebody finds out who sold their address, and folding it away would
 *  throw that answer out. */
export function sameAddress(left: string, right: string): boolean {
    return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * The line under the subject in the list.
 *
 * Built from the plain-text body wherever there is one, because the alternative
 * is stripping tags out of marketing HTML and showing somebody the words "view
 * this email in your browser" four hundred times. Quoted history is dropped:
 * the interesting part of a reply is what was added, not what was replied to.
 */
export function snippetFrom(text: string, limit = 200): string {
    const withoutQuotes = text
        .split(/\r?\n/)
        .filter((line) => !line.startsWith(">"))
        .join(" ");
    const collapsed = withoutQuotes.replace(/\s+/g, " ").trim();
    return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}…` : collapsed;
}

/** The history a plain-text reply carries above it, attributed the way every
 *  other client attributes it so the result reads the same in theirs. */
export function quoteForReply(body: string, from: MailAddress, sentAt: Date): string {
    const who = from.name.trim() ? `${from.name.trim()} <${from.address}>` : from.address;
    const when = sentAt.toISOString().slice(0, 16).replace("T", " ");
    const quoted = body.split(/\r?\n/).map((line) => (line ? `> ${line}` : ">")).join("\n");
    return `On ${when} UTC, ${who} wrote:\n${quoted}`;
}

/**
 * Who a reply goes to.
 *
 * Reply-To wins where the sender set one, which is what a mailing list and every
 * no-reply address depend on. Reply-all keeps everybody who was already there
 * minus the person replying, so nobody mails themselves and nobody is dropped.
 */
export function replyRecipients(
    envelope: MailEnvelope & { readonly replyTo: readonly MailAddress[] },
    self: readonly string[],
    all: boolean
): { readonly to: readonly MailAddress[]; readonly cc: readonly MailAddress[] } {
    const mine = new Set(self.map((address) => address.trim().toLowerCase()));
    const notMe = (entry: MailAddress) => !mine.has(entry.address.trim().toLowerCase());
    const primary = envelope.replyTo.length > 0 ? envelope.replyTo : envelope.from;
    // Replying to your own sent message goes to whoever it was sent to, not back
    // to yourself: it is the only reading of "reply" that is ever useful there.
    const to = primary.filter(notMe).length > 0 ? primary.filter(notMe) : envelope.to.filter(notMe);
    if (!all) return { to, cc: [] };
    const already = new Set(to.map((entry) => entry.address.trim().toLowerCase()));
    const cc = [...envelope.to, ...envelope.cc].filter(
        (entry) => notMe(entry) && !already.has(entry.address.trim().toLowerCase())
    );
    return { to, cc: dedupeAddresses(cc) };
}

export function dedupeAddresses(entries: readonly MailAddress[]): readonly MailAddress[] {
    const seen = new Map<string, MailAddress>();
    for (const entry of entries) {
        const key = entry.address.trim().toLowerCase();
        if (!key) continue;
        // The address that comes out is the lowercased one, whichever copy won.
        // Two headers can spell the same mailbox in two cases, and a list that
        // kept whichever arrived first would compare unequal to itself the next
        // time it was built - which shows up as a duplicate participant on a
        // conversation, or a reply-all that writes to somebody twice.
        const held = seen.get(key);
        // A later copy that carries a name beats an earlier one that does not.
        if (!held || (!held.name.trim() && entry.name.trim())) seen.set(key, { name: entry.name, address: key });
    }
    return [...seen.values()];
}

/* -------------------------------------------------------------------------- */
/* Folders                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a folder is for, as the screens name it.
 *
 * IMAP servers announce most of these themselves through SPECIAL-USE, and the
 * ones that do not are recognised by name below. It matters because every action
 * in the app is expressed against a role rather than a path: archiving is "put
 * it in whatever this server calls Archive", and a mailbox whose Sent folder is
 * called `Gesendete Objekte` has to work the same as one whose is not.
 */
export type MailFolderRole = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all" | "none";

/**
 * The roles a person may point a folder at.
 *
 * Not every role: an inbox is not a choice anybody makes, and an all-mail view
 * is the server's own idea rather than a folder somebody files into. These four
 * are the ones an action needs and a mailbox can plausibly have under a name
 * nobody recognised.
 */
export const MAIL_FOLDER_ROLES = ["trash", "junk", "archive", "sent", "drafts"] as const satisfies readonly MailFolderRole[];

/** What a role is called on screen. */
export const MAIL_FOLDER_ROLE_LABELS: Readonly<Record<string, string>> = {
    inbox: "Inbox",
    sent: "Sent",
    drafts: "Drafts",
    trash: "Trash",
    junk: "Spam",
    archive: "Archive",
    all: "All mail",
    none: "No particular use"
};

const ROLE_BY_FLAG: Readonly<Record<string, MailFolderRole>> = {
    "\\Inbox": "inbox",
    "\\Sent": "sent",
    "\\Drafts": "drafts",
    "\\Trash": "trash",
    "\\Junk": "junk",
    "\\Archive": "archive",
    "\\All": "all"
};

/**
 * Names servers use for a role when they announce no flag for it.
 *
 * Longer than it looks like it needs to be, and every entry earns its place: a
 * server that flags nothing and answers in its own language is the ordinary case
 * outside English, and the cost of not recognising one is severe. Archiving would
 * find no Archive folder, and a client that then CREATES one has written a folder
 * into somebody else's mailbox that they will see in every other client they own.
 * Polaris does not do that any more - it asks - but the ask is a worse experience
 * than knowing, so the table is where the effort goes.
 *
 * Matched on the last segment of the path, lowercased, so `INBOX/Papelera` counts.
 */
const ROLE_BY_NAME: Readonly<Record<string, MailFolderRole>> = {
    inbox: "inbox",
    "bandeja de entrada": "inbox",
    "boîte de réception": "inbox",
    posteingang: "inbox",
    "posta in arrivo": "inbox",
    "caixa de entrada": "inbox",
    "postvak in": "inbox",

    sent: "sent",
    "sent items": "sent",
    "sent mail": "sent",
    "sent messages": "sent",
    outbox: "sent",
    enviados: "sent",
    "elementos enviados": "sent",
    "correo enviado": "sent",
    gesendet: "sent",
    "gesendete objekte": "sent",
    "gesendete elemente": "sent",
    "envoyés": "sent",
    "éléments envoyés": "sent",
    "messages envoyés": "sent",
    "posta inviata": "sent",
    inviati: "sent",
    "itens enviados": "sent",
    verzonden: "sent",
    "verzonden items": "sent",
    skickat: "sent",

    drafts: "drafts",
    draft: "drafts",
    borradores: "drafts",
    "entwürfe": "drafts",
    brouillons: "drafts",
    bozze: "drafts",
    rascunhos: "drafts",
    concepten: "drafts",
    utkast: "drafts",

    trash: "trash",
    "deleted items": "trash",
    "deleted messages": "trash",
    bin: "trash",
    "recycle bin": "trash",
    papelera: "trash",
    "papelera de reciclaje": "trash",
    "elementos eliminados": "trash",
    papierkorb: "trash",
    "gelöschte objekte": "trash",
    corbeille: "trash",
    "éléments supprimés": "trash",
    cestino: "trash",
    lixeira: "trash",
    "itens excluídos": "trash",
    prullenbak: "trash",
    "verwijderde items": "trash",
    papperskorg: "trash",

    junk: "junk",
    spam: "junk",
    "junk e-mail": "junk",
    "junk email": "junk",
    "bulk mail": "junk",
    "correo no deseado": "junk",
    "correo_no_deseado": "junk",
    "no deseado": "junk",
    "unerwünscht": "junk",
    werbung: "junk",
    "courrier indésirable": "junk",
    indésirables: "junk",
    "posta indesiderata": "junk",
    "lixo eletrônico": "junk",
    ongewenst: "junk",
    skrappost: "junk",

    archive: "archive",
    archives: "archive",
    archivo: "archive",
    archivados: "archive",
    archiv: "archive",
    archivio: "archive",
    arquivo: "archive",
    archief: "archive",
    arkiv: "archive",

    "all mail": "all",
    "all messages": "all",
    todos: "all",
    "todo el correo": "all",
    "alle nachrichten": "all"
};

/** The role of a folder, from what the server flagged it and then from its name. */
export function folderRole(path: string, flags: readonly string[], delimiter: string): MailFolderRole {
    for (const flag of flags) {
        const role = ROLE_BY_FLAG[flag];
        if (role) return role;
    }
    const leaf = (delimiter ? path.split(delimiter).at(-1) : path) ?? path;
    if (path.trim().toLowerCase() === "inbox") return "inbox";
    return ROLE_BY_NAME[leaf.trim().toLowerCase()] ?? "none";
}

/** The order the roles are read in down the rail. Everything else follows,
 *  alphabetically, under its own parent. */
const ROLE_ORDER: readonly MailFolderRole[] = [
    "inbox",
    "drafts",
    "sent",
    "archive",
    "junk",
    "trash",
    "all",
    "none"
];

export function folderRank(role: MailFolderRole): number {
    const index = ROLE_ORDER.indexOf(role);
    return index === -1 ? ROLE_ORDER.length : index;
}

/** What a folder is called on screen: its leaf, with INBOX given a capital I
 *  rather than the shout the protocol requires. */
export function folderLabel(path: string, delimiter: string): string {
    if (path.trim().toLowerCase() === "inbox") return "Inbox";
    const leaf = (delimiter ? path.split(delimiter).at(-1) : path) ?? path;
    return leaf || path;
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                       */
/* -------------------------------------------------------------------------- */

export type MailRuleField =
    | "from"
    | "to"
    | "recipient"
    | "subject"
    | "body"
    | "list"
    | "attachment"
    | "size";

export type MailRuleOperator =
    | "contains"
    | "not-contains"
    | "is"
    | "is-not"
    | "starts-with"
    | "ends-with"
    | "matches"
    | "greater-than"
    | "less-than";

export interface MailRuleCondition {
    readonly field: MailRuleField;
    readonly operator: MailRuleOperator;
    readonly value: string;
}

export type MailRuleAction =
    | { readonly kind: "move"; readonly folder: string }
    | { readonly kind: "label"; readonly label: string }
    | { readonly kind: "star" }
    | { readonly kind: "read" }
    | { readonly kind: "archive" }
    | { readonly kind: "trash" }
    | { readonly kind: "junk" }
    | { readonly kind: "pin" }
    | { readonly kind: "mute" };

/** What a rule needs to know about a message to judge it. Bodies are the plain
 *  text only: matching on HTML would match on markup nobody wrote. */
export interface MailRuleSubject {
    readonly from: readonly MailAddress[];
    readonly to: readonly MailAddress[];
    readonly cc: readonly MailAddress[];
    readonly subject: string;
    readonly text: string;
    readonly listId: string;
    readonly hasAttachments: boolean;
    readonly size: number;
}

function fieldText(field: MailRuleField, message: MailRuleSubject): string {
    switch (field) {
        case "from":
            return message.from.map((entry) => `${entry.name} ${entry.address}`).join(" ");
        case "to":
            return message.to.map((entry) => `${entry.name} ${entry.address}`).join(" ");
        case "recipient":
            return [...message.to, ...message.cc].map((entry) => `${entry.name} ${entry.address}`).join(" ");
        case "subject":
            return message.subject;
        case "body":
            return message.text;
        case "list":
            return message.listId;
        case "attachment":
            return message.hasAttachments ? "yes" : "no";
        case "size":
            return String(message.size);
    }
}

/**
 * Whether one condition holds.
 *
 * `matches` is a regular expression somebody typed, so it is compiled inside a
 * try and a broken one is false rather than an exception that stops every other
 * rule in the list. A rule that never fires is a bad rule; a rule that breaks
 * filing is a lost message.
 */
export function mailConditionHolds(condition: MailRuleCondition, message: MailRuleSubject): boolean {
    if (condition.operator === "greater-than" || condition.operator === "less-than") {
        const left = Number(fieldText(condition.field, message));
        const right = Number(condition.value);
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        return condition.operator === "greater-than" ? left > right : left < right;
    }
    const haystack = fieldText(condition.field, message).toLowerCase();
    const needle = condition.value.trim().toLowerCase();
    switch (condition.operator) {
        case "contains":
            return haystack.includes(needle);
        case "not-contains":
            return !haystack.includes(needle);
        case "is":
            return haystack.trim() === needle;
        case "is-not":
            return haystack.trim() !== needle;
        case "starts-with":
            return haystack.trimStart().startsWith(needle);
        case "ends-with":
            return haystack.trimEnd().endsWith(needle);
        case "matches":
            try {
                return new RegExp(condition.value, "i").test(fieldText(condition.field, message));
            } catch {
                return false;
            }
    }
}

export interface MailRule {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    /** All conditions have to hold, or any one of them. */
    readonly match: "all" | "any";
    readonly conditions: readonly MailRuleCondition[];
    readonly actions: readonly MailRuleAction[];
    /** Whether a match here stops the rules below it from being considered. */
    readonly stop: boolean;
}

export function mailRuleMatches(rule: MailRule, message: MailRuleSubject): boolean {
    if (!rule.enabled || rule.conditions.length === 0) return false;
    return rule.match === "all"
        ? rule.conditions.every((condition) => mailConditionHolds(condition, message))
        : rule.conditions.some((condition) => mailConditionHolds(condition, message));
}

/**
 * Everything a person's rules say to do with one message, in order.
 *
 * Returned rather than performed, so the same list can be shown on a "what would
 * this rule have done" screen without a message being moved to find out. A rule
 * with `stop` ends the walk after its own actions are collected.
 */
export function mailActionsFor(
    rules: readonly MailRule[],
    message: MailRuleSubject
): readonly MailRuleAction[] {
    const actions: MailRuleAction[] = [];
    for (const rule of rules) {
        if (!mailRuleMatches(rule, message)) continue;
        actions.push(...rule.actions);
        if (rule.stop) break;
    }
    return actions;
}

/* -------------------------------------------------------------------------- */
/* Privacy                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hosts that exist to tell a sender that a message was opened.
 *
 * Remote content is blocked for everybody by default, so this list is not what
 * protects anybody: it is what lets the message say "this had four trackers in
 * it, from these companies" instead of "some images were blocked", which is the
 * difference between a setting people leave on and one they switch off in
 * annoyance. Being absent from this list makes a pixel unnamed, never allowed.
 *
 * enigma:allow-no-consent - these names are a blocklist, not an integration.
 * Nothing here is loaded, contacted or measured against; a host appearing in
 * this table is a host whose request has already been refused, and the only use
 * of the name beside it is a sentence on screen telling the reader who tried.
 */
const TRACKER_HOSTS: Readonly<Record<string, string>> = {
    "mailchimp.com": "Mailchimp",
    "list-manage.com": "Mailchimp",
    "mandrillapp.com": "Mailchimp",
    "sendgrid.net": "SendGrid",
    "sendgrid.com": "SendGrid",
    "hubspot.com": "HubSpot",
    "hubspotemail.net": "HubSpot",
    "hs-sites.com": "HubSpot",
    "sparkpostmail.com": "SparkPost",
    "mailgun.org": "Mailgun",
    "mailgun.net": "Mailgun",
    "postmarkapp.com": "Postmark",
    "customer.io": "Customer.io",
    "cust-io.com": "Customer.io",
    "braze.com": "Braze",
    "iterable.com": "Iterable",
    "klaviyomail.com": "Klaviyo",
    "klaviyo.com": "Klaviyo",
    "sailthru.com": "Sailthru",
    "exacttarget.com": "Salesforce",
    "exct.net": "Salesforce",
    "marketo.com": "Marketo",
    "mktoresp.com": "Marketo",
    "pardot.com": "Pardot",
    "intercom-mail.com": "Intercom",
    "intercomcdn.com": "Intercom",
    "amazonses.com": "Amazon SES",
    "mixpanel.com": "Mixpanel",
    "segment.com": "Segment",
    "bnc.lt": "Branch",
    "getresponse.com": "GetResponse",
    "sendinblue.com": "Brevo",
    "brevo.com": "Brevo",
    "sendpulse.com": "SendPulse",
    "convertkit-mail.com": "Kit",
    "ck.page": "Kit",
    "substack.com": "Substack",
    "beehiiv.com": "beehiiv",
    "mailerlite.com": "MailerLite",
    "ml-attach.com": "MailerLite",
    "constantcontact.com": "Constant Contact",
    "rs6.net": "Constant Contact",
    "campaign-archive.com": "Mailchimp",
    "streak.com": "Streak",
    "mailtrack.io": "Mailtrack",
    "bananatag.com": "Bananatag",
    "yesware.com": "Yesware",
    "mailtracker.io": "Mailtracker",
    "sidekickopen.com": "HubSpot Sales",
    "cirrusinsight.com": "Cirrus Insight",
    "outreach.io": "Outreach",
    "salesloft.com": "Salesloft",
    "hubspotlinks.com": "HubSpot",
    "doubleclick.net": "Google Ads",
    "google-analytics.com": "Google Analytics",
    "facebook.com": "Meta",
    "fb.com": "Meta"
};

export interface RemoteResource {
    readonly url: string;
    /** Its rendered size where the markup gave one, so a pixel can be named as
     *  one even when its host is not in the list above. */
    readonly width?: number;
    readonly height?: number;
}

export interface TrackerFinding {
    readonly url: string;
    /** The company, where the host says which. Empty when it is unrecognised
     *  and was judged by its size instead. */
    readonly vendor: string;
    readonly host: string;
}

/** The registered-looking tail of a host, for matching the table above. */
function hostSuffixes(host: string): readonly string[] {
    const parts = host.trim().toLowerCase().split(".");
    const out: string[] = [];
    for (let index = 0; index < parts.length - 1; index += 1) out.push(parts.slice(index).join("."));
    return out;
}

/** Whether this resource is there to be counted rather than to be seen. */
export function trackerFor(resource: RemoteResource): TrackerFinding | null {
    let host = "";
    try {
        host = new URL(resource.url).hostname;
    } catch {
        return null;
    }
    for (const suffix of hostSuffixes(host)) {
        const vendor = TRACKER_HOSTS[suffix];
        if (vendor) return { url: resource.url, vendor, host };
    }
    // An image nobody could see is an image nobody was meant to see.
    const tiny = (value: number | undefined) => value !== undefined && value <= 2;
    if (tiny(resource.width) && tiny(resource.height)) return { url: resource.url, vendor: "", host };
    return null;
}

export function trackersIn(resources: readonly RemoteResource[]): readonly TrackerFinding[] {
    const found: TrackerFinding[] = [];
    const seen = new Set<string>();
    for (const resource of resources) {
        const finding = trackerFor(resource);
        if (!finding || seen.has(finding.url)) continue;
        seen.add(finding.url);
        found.push(finding);
    }
    return found;
}

/** The companies named in a set of findings, each once, for the one-line
 *  summary above the message. */
export function trackerVendors(findings: readonly TrackerFinding[]): readonly string[] {
    return [...new Set(findings.map((finding) => finding.vendor).filter(Boolean))];
}

/* -------------------------------------------------------------------------- */
/* Remote content                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The parameters a link carries to say who followed it.
 *
 * Stripped from every link in a message before it is drawn, so clicking one
 * tells the far end that somebody arrived and not which somebody. It is the
 * cheapest privacy win in a mail client and the one nobody notices, which is the
 * point: the link still goes where it says it goes.
 *
 * Only parameters that are unambiguously identifiers. Anything a site might
 * actually route on stays, because a link that lands on the wrong page is worse
 * than a link that was counted.
 */
const TRACKING_PARAMS = [
    /^utm_/i,
    /^ga_/i,
    /^mc_(?:cid|eid)$/i,
    /^_hs(?:enc|mi)$/i,
    /^hsCtaTracking$/i,
    /^vero_(?:conv|id)$/i,
    /^wickedid$/i,
    /^oly_(?:anon|enc)_id$/i,
    /^mkt_tok$/i,
    /^trk$/i,
    /^trkCampaign$/i,
    /^sc_campaign$/i,
    /^ref_?src$/i,
    /^igshid$/i,
    /^fbclid$/i,
    /^gclid$/i,
    /^dclid$/i,
    /^msclkid$/i,
    /^twclid$/i,
    /^yclid$/i,
    /^s_cid$/i,
    /^ck_subscriber_id$/i,
    /^email_(?:source|campaign)$/i
];

/** The same link with the parameters that identify the reader taken off. An
 *  address that cannot be parsed comes back untouched: a link nobody can read
 *  is not a link to rewrite. */
export function cleanLink(address: string): string {
    let url: URL;
    try {
        url = new URL(address);
    } catch {
        return address;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return address;
    let changed = false;
    for (const key of [...url.searchParams.keys()]) {
        if (!TRACKING_PARAMS.some((pattern) => pattern.test(key))) continue;
        url.searchParams.delete(key);
        changed = true;
    }
    return changed ? url.toString() : address;
}

/**
 * Every address a message would fetch from somewhere else if it were drawn.
 *
 * A scan rather than a parse, and deliberately so: this feeds the count above
 * the message and the tracker report, neither of which is a security boundary.
 * What stops the message doing anything is that it is drawn inside a sandboxed
 * frame with a policy that forbids every outside load, and that its markup goes
 * through a sanitizer in the browser first. A regular expression that missed one
 * would understate a number; it could never let one load.
 */
export function remoteResourcesIn(html: string): readonly RemoteResource[] {
    const found: RemoteResource[] = [];
    const seen = new Set<string>();
    const push = (url: string, width?: number, height?: number) => {
        const address = url.trim();
        if (!/^https?:\/\//i.test(address) || seen.has(address)) return;
        seen.add(address);
        found.push({ url: address, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) });
    };

    // Images, with whatever size the markup declared - a one-pixel image is a
    // tracker whether or not its host is one anybody has heard of.
    for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
        const src = /\bsrc\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
        if (!src) continue;
        const width = Number(/\bwidth\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
        const height = Number(/\bheight\s*=\s*["']?(\d+)/i.exec(tag)?.[1]);
        push(src, Number.isFinite(width) ? width : undefined, Number.isFinite(height) ? height : undefined);
    }
    // Backgrounds, in an attribute or in a style, which is how the same pixel is
    // hidden from a client that only looks at img tags.
    for (const match of html.matchAll(/url\(\s*["']?([^"')]+)/gi)) push(match[1] ?? "");
    for (const match of html.matchAll(/\bbackground\s*=\s*["']?([^"'\s>]+)/gi)) push(match[1] ?? "");
    return found;
}

/**
 * The same markup with every outside address moved out of the way.
 *
 * The address is not thrown away: it is parked on a `data-remote` attribute, so
 * pressing "show pictures" is the browser putting back what it already has
 * rather than a second request to this server for the message.
 */
export function holdRemoteContent(html: string): string {
    return (
        html
            // Every attribute that can name something to fetch. `srcset` too, or a
            // browser picking a candidate loads one after the src has been held.
            .replace(
                /\b(src|srcset|background|poster)\s*=\s*(["'])(https?:\/\/[^"']*)\2/gi,
                (_match, name: string, quote: string, url: string) =>
                    `data-remote-${name.toLowerCase()}=${quote}${url}${quote}`
            )
            // A style attribute or block can name one too, and there is no
            // attribute to rename - so the function call itself is broken.
            .replace(/url\(\s*(["']?)(https?:\/\/[^"')]+)\1\s*\)/gi, "url($1about:blank$1)")
    );
}
