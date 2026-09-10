/**
 * A `mailto:` link, read into something the composer can open with.
 *
 * Polaris registers itself as the browser's handler for these, so any "email
 * us" link on any page opens a message here instead of in a desktop client the
 * person does not use. The link is written by whoever made that page, so it is
 * somebody else's input from start to finish: every address is checked by the
 * same rule a recipient typed into the composer is, anything that fails it is
 * dropped rather than carried into the To line, and the text fields are bounded.
 *
 * The format is RFC 6068: addresses before the `?`, comma-separated, then
 * `to`, `cc`, `bcc`, `subject` and `body` as percent-encoded query fields.
 * Anything else in the query - `in-reply-to`, a header nobody should be able to
 * set from a link - is ignored.
 */

import { z } from "zod";
import { mailAddress, normalizeMailName } from "./schemas/mailbox.js";

/** What a link may put in the composer. A body from a link is a line or two,
 *  not a newsletter, so the ceiling is a letter's. */
export const mailtoSeedSchema = z.object({
    to: z.array(mailAddress).max(50),
    cc: z.array(mailAddress).max(50),
    bcc: z.array(mailAddress).max(50),
    subject: z.string().transform(normalizeMailName).pipe(z.string().max(500)),
    body: z.string().max(20_000)
});

export type MailtoSeed = z.infer<typeof mailtoSeedSchema>;

/**
 * A link's body, as the Markdown the composer holds.
 *
 * A mailto body is plain text, and Markdown would read it as something else:
 * two lines run together into one, an asterisk becomes emphasis, a line that
 * starts with `#` becomes a heading. So every character Markdown gives meaning
 * to is escaped, a line break inside a paragraph becomes a hard break (the
 * trailing backslash the editor itself writes one as), and a blank line stays a
 * new paragraph - the text arrives exactly as the link spelled it.
 */
export function plainTextToMarkdown(text: string): string {
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    const escaped = lines.map((line) =>
        line
            .replace(/([\\`*_[\]<>~|])/g, "\\$1")
            .replace(/^(\s*)([#+\-!=])/, "$1\\$2")
            // A number is not escapable in Markdown - `\1.` shows its
            // backslash - so the full stop after it is what gets escaped.
            .replace(/^(\s*\d+)([.)])/, "$1\\$2")
    );
    return escaped
        .map((line, index) => {
            const next = escaped[index + 1];
            return line !== "" && next !== undefined && next !== "" ? `${line}\\` : line;
        })
        .join("\n");
}

/** The addresses in one comma-separated field, each checked, the bad ones gone. */
function addressesIn(field: string): string[] {
    return field
        .split(",")
        .map((part) => mailAddress.safeParse(part))
        .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
}

/** Percent-decoding that does not throw on a stray `%`: a malformed link is read
 *  as far as it goes rather than refused whole. */
function decoded(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/**
 * Read a `mailto:` link. Null when it is not one at all; otherwise every field
 * decided, with addresses that were not addresses left out.
 */
export function parseMailto(link: string): MailtoSeed | null {
    const raw = link.trim();
    if (!/^mailto:/i.test(raw)) return null;
    const rest = raw.slice("mailto:".length);
    const mark = rest.indexOf("?");
    const head = mark === -1 ? rest : rest.slice(0, mark);
    const query = mark === -1 ? "" : rest.slice(mark + 1);

    const to = addressesIn(decoded(head));
    const cc: string[] = [];
    const bcc: string[] = [];
    let subject = "";
    let body = "";
    for (const pair of query.split("&")) {
        if (!pair) continue;
        const equals = pair.indexOf("=");
        const key = decoded(equals === -1 ? pair : pair.slice(0, equals)).toLowerCase();
        // `+` is a space in a form, never in a mailto: RFC 6068 says percent
        // encoding only, and a subject of "C++ question" must survive.
        const value = equals === -1 ? "" : decoded(pair.slice(equals + 1));
        if (key === "to") to.push(...addressesIn(value));
        else if (key === "cc") cc.push(...addressesIn(value));
        else if (key === "bcc") bcc.push(...addressesIn(value));
        else if (key === "subject") subject = value;
        else if (key === "body") body = value;
    }

    const parsed = mailtoSeedSchema.safeParse({
        to: [...new Set(to)].slice(0, 50),
        cc: [...new Set(cc)].slice(0, 50),
        bcc: [...new Set(bcc)].slice(0, 50),
        subject: subject.slice(0, 500),
        body: body.slice(0, 20_000)
    });
    return parsed.success ? parsed.data : null;
}
