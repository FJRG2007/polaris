/**
 * What happened to a message after Send was pressed, decided from what the
 * servers actually said.
 *
 * Two questions live here, both pure, because both decide something a person
 * reads and neither may be guessed at:
 *
 * - **Was this refusal final?** A 5xx is the receiving side saying "not ever";
 *   a 4xx is "not now". Retrying a 5xx sends the same rejection five more times
 *   and leaves the sender watching a message that says it is on its way. Giving
 *   up on a 4xx loses mail that would have gone on the next try.
 * - **Is this arriving message a delivery report, and which of my messages is it
 *   about?** A bounce is the only honest evidence an ordinary mailbox ever gets
 *   that something did not arrive, and it arrives as a perfectly ordinary
 *   message that nobody reads.
 *
 * Nothing here is allowed to invent certainty. A report that does not name a
 * message returns no message, and the caller leaves the send where it was:
 * "handed over, nothing came back" is the truth in that case, and it is a
 * different sentence from "delivered".
 */

/** How final a refusal was. */
export type MailSendVerdict = "permanent" | "temporary";

/** What a failed submission is understood as. */
export interface MailSendFailure {
    readonly verdict: MailSendVerdict;
    /** The SMTP reply code, or 0 where the server never answered. */
    readonly code: number;
    /** The server's own reply, on one line, or "" when it never spoke. Only ever
     *  taken from a reply: a socket error's message names the host somebody's
     *  mailbox is configured with, and that is Polaris' to say in its own words. */
    readonly reason: string;
}

/** The shape a submission failure arrives in. */
export interface MailSendFailureInput {
    /** The SMTP reply code the library read off the answer. */
    readonly responseCode?: unknown;
    /** The library's own class of failure: `ESOCKET`, `ETIMEDOUT`, `EENVELOPE`. */
    readonly code?: unknown;
    /** The server's reply line, verbatim. */
    readonly response?: unknown;
}

/** How much of a server's reply is worth putting on a screen. Past this it is a
 *  paragraph of somebody else's policy documentation, which is a link in the
 *  reply anyway. */
const REASON_MAX = 240;

/** The library's own failures that are worth another try: nothing was refused,
 *  the conversation never finished. */
const TEMPORARY_KINDS = new Set(["ESOCKET", "ETIMEDOUT", "ECONNECTION", "EDNS", "ECONNRESET"]);

/** One line, no control characters, and short enough to read. */
function oneLine(text: string): string {
    const flattened = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    return flattened.length > REASON_MAX ? `${flattened.slice(0, REASON_MAX - 1)}…` : flattened;
}

/**
 * Read a submission failure.
 *
 * Unrecognised is temporary, which is the safer of the two mistakes: a message
 * tried again is at worst a duplicate refusal in a log, and a message given up
 * on is one somebody believes they sent.
 */
export function judgeSendFailure(failure: MailSendFailureInput): MailSendFailure {
    const code = typeof failure.responseCode === "number" ? failure.responseCode : 0;
    const reason = typeof failure.response === "string" ? oneLine(failure.response) : "";
    const kind = typeof failure.code === "string" ? failure.code.toUpperCase() : "";

    if (code >= 500 && code < 600) return { verdict: "permanent", code, reason };
    if (code >= 400 && code < 500) return { verdict: "temporary", code, reason };
    if (TEMPORARY_KINDS.has(kind)) return { verdict: "temporary", code, reason };
    // The envelope was refused without a code Polaris could read - an address
    // the server will not take. Trying it again changes nothing about the
    // address.
    if (kind === "EENVELOPE" || kind === "EMESSAGE") return { verdict: "permanent", code, reason };
    return { verdict: "temporary", code, reason };
}

/**
 * What the sender is told about a message that did not go.
 *
 * The server's own words where there are any, because "it would not take it" is
 * the sentence that makes somebody retype a message that was refused for having
 * an attachment too large. Polaris' own words where the server never spoke, so
 * a timeout does not read as a rejection.
 */
export function sendFailureSentence(failure: MailSendFailure): string {
    if (failure.verdict === "permanent") {
        return failure.reason
            ? `Not sent. The outgoing server refused it: ${failure.reason}`
            : "Not sent. The outgoing server refused this message.";
    }
    return failure.reason
        ? `Not sent yet. The outgoing server said: ${failure.reason} Polaris will try again.`
        : "Not sent yet. Polaris could not reach the outgoing server, and will try again.";
}

/** What the sender is told when the server took the message for some recipients
 *  and refused it for others. The ones it refused never got it, and that is the
 *  half nobody finds out about on their own. */
export function partialSendSentence(refused: readonly string[]): string {
    if (refused.length === 0) return "";
    const named = refused.slice(0, 3).join(", ");
    const rest = refused.length - Math.min(3, refused.length);
    return rest > 0
        ? `The outgoing server would not send it to ${named} and ${rest} more.`
        : `The outgoing server would not send it to ${named}.`;
}

/* -------------------------------------------------------------------------- */
/* Delivery reports                                                            */
/* -------------------------------------------------------------------------- */

/** What a delivery report says happened. */
export type MailReportKind = "failed" | "delayed" | "delivered";

/** A delivery report, read. */
export interface MailDeliveryReport {
    readonly kind: MailReportKind;
    /** The Message-Id of what it is about, bare, or "" where the report names
     *  none. Empty is a report that cannot be tied to anything, and the caller
     *  must leave the send it cannot name alone. */
    readonly aboutMessageId: string;
    /** The address that did not receive it, or "". */
    readonly recipient: string;
    /** The enhanced status code (RFC 3463), "5.1.1", or "". */
    readonly status: string;
    /** Why, in the receiving server's own words, or "". */
    readonly reason: string;
}

/** The message a report is read out of. Everything here is already on the row a
 *  sync wrote: no part of this reaches for the mail server. */
export interface MailReportSource {
    readonly subject: string;
    /** The sender's address, lowercased. */
    readonly from: string;
    /** The Message-Id this is an answer to, bare, where the reporting server set
     *  one. Several do; several do not, which is why the body is read too. */
    readonly inReplyTo: string;
    /** The References chain, bare ids. */
    readonly references: readonly string[];
    /** Whatever `Auto-Submitted` said, or "". */
    readonly autoSubmitted: string;
    /** The human-readable part of the report. The machine-readable part is a
     *  separate MIME part that a client does not fetch, so this is read for the
     *  same facts stated in prose - which every reporting server also does,
     *  because the part people read is the point of a bounce. */
    readonly text: string;
}

/** The local part of an address that is a mail system rather than a person. */
const DAEMON_NAMES = ["mailer-daemon", "postmaster", "mail-daemon", "mdaemon", "bounce"];

/** What a reporting server calls its own message. Several languages, because a
 *  server answers in its own and the reader's mailbox is full of them. */
const REPORT_SUBJECTS =
    /(undelivered|undeliverable|delivery status notification|delivery (has )?failed|delivery failure|failure notice|returned mail|mail delivery (failed|subsystem)|no se (ha )?pudo? entregar|no se ha podido entregar|correo devuelto|nicht zustellbar|unzustellbar)/i;

/** The lines only a delivery report has. Stated in the human-readable part by
 *  every server worth reading one from. */
const REPORT_BODY =
    /(final-recipient:|original-recipient:|diagnostic-code:|action:\s*(failed|delayed|delivered)|reporting-mta:|status:\s*[245]\.\d{1,3}\.\d{1,3})/i;

/** An enhanced status code, on its own or after `Status:`. */
const STATUS_CODE = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;

/** A bare address, near enough. Deliberately loose: what is matched here is
 *  checked against the addresses Polaris knows it sent to. */
const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** A Message-Id inside angle brackets. */
const BRACKETED = /<([^<>\s]+@[^<>\s]+)>/g;

function localPart(address: string): string {
    return address.split("@")[0]?.toLowerCase() ?? "";
}

/** Whether this address is a mail system announcing itself. */
export function isMailDaemon(address: string): boolean {
    const local = localPart(address);
    return DAEMON_NAMES.some((name) => local === name || local.startsWith(`${name}+`));
}

/**
 * Read an arriving message as a delivery report, or decide it is not one.
 *
 * Two independent things have to agree before a message is treated as a report:
 * it has to come from a mail system or say in its subject that it is one, and
 * its body has to carry the lines a report carries. One alone is a person
 * writing "delivery failed" about something else, or a newsletter from an
 * address called `bounce@`, and calling either a bounce would mark a message
 * that arrived perfectly well as one that did not.
 */
export function readDeliveryReport(source: MailReportSource): MailDeliveryReport | null {
    const text = source.text ?? "";
    const auto = source.autoSubmitted.toLowerCase();
    const announced =
        isMailDaemon(source.from) ||
        REPORT_SUBJECTS.test(source.subject) ||
        auto.startsWith("auto-replied") ||
        auto.startsWith("auto-generated");
    if (!announced) return null;
    if (!REPORT_BODY.test(text)) return null;

    const status = STATUS_CODE.exec(text)?.[0] ?? "";
    return {
        kind: reportKind(text, status),
        aboutMessageId: aboutMessageId(source, text),
        recipient: reportRecipient(source, text),
        status,
        reason: reportReason(text)
    };
}

function reportKind(text: string, status: string): MailReportKind {
    if (/action:\s*delayed/i.test(text) || status.startsWith("4")) return "delayed";
    if (/action:\s*delivered/i.test(text) || status.startsWith("2")) return "delivered";
    return "failed";
}

/**
 * Which message this is about.
 *
 * The headers first, because a server that answered the message by its id is
 * telling the truth about which one it means. The returned copy inside the
 * report second: a report carries the original's own headers, and its
 * `Message-ID:` line is in them. Both are ids Polaris then has to recognise as
 * one of its own sends - an id read here that matches nothing is the same as no
 * id at all.
 */
function aboutMessageId(source: MailReportSource, text: string): string {
    if (source.inReplyTo) return source.inReplyTo;
    const quoted = /message-id:\s*<([^<>\s]+@[^<>\s]+)>/i.exec(text);
    if (quoted?.[1]) return quoted[1];
    const last = source.references.at(-1);
    if (last) return last;
    // A lone bracketed id in the prose, where there is exactly one: more than
    // one and there is nothing to choose between them.
    const found = [...text.matchAll(BRACKETED)].map((match) => match[1] ?? "");
    const unique = [...new Set(found)];
    return unique.length === 1 ? (unique[0] ?? "") : "";
}

/** The address that did not get it. Never the reporting system's own, and never
 *  the mailbox the report arrived in. */
function reportRecipient(source: MailReportSource, text: string): string {
    const stated = /(?:final|original)-recipient:\s*(?:rfc822;)?\s*([^\s<>;]+@[^\s<>;]+)/i.exec(text);
    if (stated?.[1]) return stated[1].toLowerCase();
    const found = [...text.matchAll(ADDRESS)].map((match) => match[0].toLowerCase());
    return found.find((address) => address !== source.from && !isMailDaemon(address)) ?? "";
}

/**
 * Why, in the reporting server's words.
 *
 * The diagnostic line where there is one, because that is the receiving
 * server's own sentence and it is usually the whole answer ("mailbox full",
 * "user unknown"). Failing that, the first line carrying a reply code, which is
 * what a server writing prose puts its reason on.
 */
function reportReason(text: string): string {
    const diagnostic = /diagnostic-code:\s*(?:smtp;)?\s*([^\r\n]+)/i.exec(text);
    if (diagnostic?.[1]) return oneLine(diagnostic[1]);
    const lines = text.split(/\r?\n/);
    const spoken = lines.find((line) => /\b[45]\d\d[ -]/.test(line) && STATUS_CODE.test(line));
    if (spoken) return oneLine(spoken);
    const coded = lines.find((line) => /\b[45]\d\d[ -]\S/.test(line));
    return coded ? oneLine(coded) : "";
}

/**
 * What the sender is told about a report.
 *
 * "Bounced" and nothing else is a sentence people learn to ignore; the address
 * and the server's own reason are what turns it into something to do.
 */
export function deliveryReportSentence(report: MailDeliveryReport): string {
    const who = report.recipient ? ` to ${report.recipient}` : "";
    const why = report.reason ? `: ${report.reason}` : ".";
    if (report.kind === "delayed") return `Not delivered${who} yet, and the server is still trying${why}`;
    if (report.kind === "delivered") return `Delivered${who}.`;
    return `It did not reach${who || " the address it was sent to"}${why}`;
}
