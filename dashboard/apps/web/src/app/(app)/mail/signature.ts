/**
 * The signature, as the composer writes it.
 *
 * The line above it is the one thing about a signature that is not taste: two
 * hyphens, a space, and the end of the line (RFC 3676, 4.3). It is what every
 * client reads as "the signature starts here", what lets one fold it away, and
 * what the send path looks for before adding a signature of its own. A line
 * that has lost its space, or gained a backslash, is none of those things.
 */

import type { MailIdentityView } from "@/lib/mailbox/labels";
import type { MailAccountView } from "@/lib/mailbox/accounts";

/** The line a signature starts under, without its line break. */
export const SIGNATURE_DELIMITER = "-- ";

/** The delimiter and the signature under it. */
export function signatureBlock(signature: string): string {
    return `${SIGNATURE_DELIMITER}\n${signature}`;
}

/**
 * The delimiter line as the editor hands it back.
 *
 * The editor stores Markdown, and its serializer escapes a hyphen at the start
 * of a line so it is not read back as a list or a heading - which turns the
 * delimiter into `\-- `, or `\-\- ` once that has been read back and written
 * again, with a trailing backslash where the line was ended with a hard break.
 * As the first line of a paragraph it needs none of them: nothing reads `-- `
 * there as anything but text.
 */
const ESCAPED_DELIMITER = /^(?:\\?-){2} \\?$/;

/** A line that opens or closes a fenced code block. */
const FENCE = /^\s*(?:```|~~~)/;

/**
 * The body with every signature delimiter the editor escaped written back as
 * the delimiter.
 *
 * Only a line that starts a paragraph - the first line, or one after a blank
 * line - and only outside a code block: anywhere else the escape is what keeps
 * the line from turning the one above it into a heading, and inside a fence it
 * is what somebody typed.
 */
export function keepSignatureDelimiter(body: string): string {
    if (!body.includes("- ")) return body;
    const lines = body.split("\n");
    let fenced = false;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (FENCE.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced || line === SIGNATURE_DELIMITER) continue;
        const opensParagraph = index === 0 || (lines[index - 1] ?? "").trim() === "";
        if (opensParagraph && ESCAPED_DELIMITER.test(line)) lines[index] = SIGNATURE_DELIMITER;
    }
    return lines.join("\n");
}

/** What a composer is opened with, as far as its signature is concerned. */
export interface SignedSeed {
    readonly body?: string;
    readonly inReplyToId?: string | null;
    readonly draftId?: string | null;
}

/**
 * What the composer opens with, signature included.
 *
 * A signature that has to be inserted by hand every time is one nobody ever
 * sends, which is what "very basic" meant. Each mailbox says when its own goes
 * in: never, on a message somebody starts, or on replies and forwards as well.
 *
 * Where it goes is the other half and it is not decoration. Above the quoted
 * history is what everybody expects and what makes a reply readable; below it is
 * what a mailing list expects. The mailbox already carried that choice and
 * nothing had ever read it.
 *
 * A draft being reopened is left as it was: it already has whatever its author
 * decided, and adding a second signature to it every time they come back to it
 * is the bug this feature usually ships with. Only a delimiter the editor
 * escaped when it was saved is put back.
 */
export function withSignature(
    seed: SignedSeed,
    account:
        | Pick<MailAccountView, "signature" | "signatureAuto" | "signatureAboveQuote">
        | undefined,
    identity: Pick<MailIdentityView, "signature"> | undefined
): string {
    const body = keepSignatureDelimiter(seed.body ?? "");
    if (seed.draftId) return body;

    const signature = (identity?.signature || account?.signature || "").trim();
    if (!signature) return body;

    const when = account?.signatureAuto ?? "new";
    const answering = Boolean(seed.inReplyToId);
    if (when === "never") return body;
    if (when === "new" && answering) return body;

    const block = signatureBlock(signature);
    if (!body.trim()) return `\n\n${block}`;
    return account?.signatureAboveQuote === false ? `${body}\n\n${block}` : `\n\n${block}\n${body}`;
}
