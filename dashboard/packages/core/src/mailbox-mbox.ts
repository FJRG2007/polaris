/**
 * The mbox format, which is older than almost everything and still the only
 * thing every mail client can read.
 *
 * An mbox file is messages one after another, each preceded by a line beginning
 * `From ` - a space, not a colon. That is the whole format, and it is also the
 * whole problem with it: a line inside a message that happens to begin `From `
 * is indistinguishable from the start of the next message, so writers escape it
 * to `>From ` and readers put it back. Getting that wrong splits somebody's
 * archive in half at the first message that quotes a forwarded header, which is
 * a corruption nobody notices until they open the file years later.
 *
 * So the framing lives here, pure and tested, rather than inline in whatever
 * builds the export. There is very little of it and every line is a way to lose
 * an archive.
 *
 * The `From ` line's address and date are not really data - readers ignore
 * everything after the word - but they are written properly anyway, because the
 * first thing anybody does with an export is open it in a text editor.
 */

/** The separator line before one message. `asctime`, which is what every mbox
 *  in the world uses, rather than an ISO date. */
export function mboxFromLine(address: string, at: Date): string {
    const sender = address.trim() || "MAILER-DAEMON";
    return `From ${sender} ${at.toUTCString()}`;
}

/**
 * A message body, escaped so it cannot be read as the start of another.
 *
 * Every line beginning `From ` gains a `>`, including one already escaped -
 * `>From ` becomes `>>From `, which is what makes the escaping reversible. A
 * reader strips exactly one `>` from any line matching `>*From `.
 */
export function escapeMboxBody(body: string): string {
    return body.replace(/^(>*From )/gm, ">$1");
}

/** And back. Used by the importer, which is the only reason the escaping above
 *  has to be exactly reversible. */
export function unescapeMboxLine(line: string): string {
    return /^>+From /.test(line) ? line.slice(1) : line;
}

/**
 * One message, framed.
 *
 * The trailing blank line is part of the format rather than tidiness: without it
 * the next `From ` line is not at the start of a line of its own for readers
 * that split on `\n\nFrom `.
 */
export function mboxEntry(raw: string, address: string, at: Date): string {
    const body = escapeMboxBody(raw.replace(/\r\n/g, "\n").replace(/\n*$/, ""));
    return `${mboxFromLine(address, at)}\n${body}\n\n`;
}

/**
 * Split an mbox file back into messages.
 *
 * A `From ` line only starts a message at the very beginning of the file or
 * after a blank line - which is the rule that stops a quoted header inside a
 * message from being read as a separator even when a writer failed to escape it.
 * Every message that comes back out is unescaped, so what a reader gets is the
 * bytes that went in.
 */
export function readMbox(text: string): string[] {
    const lines = text.replace(/\r\n/g, "\n").split("\n");
    const messages: string[] = [];
    let current: string[] | null = null;
    let blankBefore = true;

    for (const line of lines) {
        if (line.startsWith("From ") && blankBefore) {
            if (current) messages.push(current.join("\n").replace(/\n*$/, ""));
            current = [];
            blankBefore = false;
            continue;
        }
        blankBefore = line.trim().length === 0;
        if (current) current.push(unescapeMboxLine(line));
    }
    if (current) messages.push(current.join("\n").replace(/\n*$/, ""));
    const found = messages.filter((one) => one.trim().length > 0);
    // No separator anywhere. Somebody renamed a `.eml`, or exported from
    // something that writes one message per file. Answering with nothing would
    // be worse than answering with the message that is plainly in there.
    if (found.length === 0 && text.trim().length > 0) {
        return [text.replace(/\r\n/g, "\n").replace(/\n*$/, "")];
    }
    return found;
}

/** What an exported file is called. Named for the mailbox and the day, because
 *  the second thing anybody does with an export is make another one. */
export function mboxFilename(address: string, at: Date): string {
    const safe = address
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        // A run of dots is how a name walks up a directory, and this string is
        // handed to a browser as the name to save under. One dot is a domain
        // separator and is kept; two never are.
        .replace(/\.{2,}/g, ".")
        .replace(/^[.-]+|[.-]+$/g, "");
    return `${safe || "mailbox"}-${at.toISOString().slice(0, 10)}.mbox`;
}
