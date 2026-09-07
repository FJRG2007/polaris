/**
 * Turning what a mail server hands over into text a person can read.
 *
 * Two transformations, and skipping either leaves a message looking corrupted.
 * They were skipped, which is how a Spanish thread came out as
 * `Mar=C3=ADa` and `=C2=BFqu=C3=A9 tal?` in every preview line in the list.
 *
 * **The transfer encoding.** A message part is not sent as its bytes: anything
 * with an accent in it is wrapped in quoted-printable (`=C3=AD`) or base64,
 * because SMTP was specified when a byte with the high bit set could not be
 * relied on to survive the journey. The part's own structure says which.
 *
 * **The character set.** What comes out of that is still bytes, and only the
 * part says what they mean. UTF-8 is the common case and Latin-1 is the one
 * still in the wild - a message from an older client, or from a system that has
 * been forwarding the same footer since 2004.
 *
 * Deliberately tolerant: a part that claims an encoding it does not use, or a
 * charset nothing has heard of, comes back as UTF-8 rather than as an error. A
 * preview line that is slightly wrong is worth having; a message that will not
 * open is not.
 */

import iconv from "iconv-lite";

/**
 * Quoted-printable, undone.
 *
 * Written here rather than pulled from a library: it is a dozen lines, the
 * format has not changed since 1996, and the one package that does it ships no
 * types. `=XX` is a byte written as hex, and `=` at the end of a line is a soft
 * break the sender added to keep the line under 76 characters - it is not part
 * of the text and has to come out with the newline after it.
 */
function decodeQuotedPrintable(raw: string): Buffer {
    const joined = raw.replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let at = 0; at < joined.length; at += 1) {
        const char = joined[at]!;
        if (char !== "=") {
            out.push(char.charCodeAt(0) & 0xff);
            continue;
        }
        const hex = joined.slice(at + 1, at + 3);
        const byte = /^[0-9a-f]{2}$/i.test(hex) ? Number.parseInt(hex, 16) : Number.NaN;
        if (Number.isNaN(byte)) {
            // A lone `=` that is not an escape. Senders do produce them, and
            // dropping the rest of the message over one is not an option.
            out.push(0x3d);
            continue;
        }
        out.push(byte);
        at += 2;
    }
    return Buffer.from(out);
}

/** What a part says about itself, off its structure or its download metadata. */
export interface PartEncoding {
    /** `quoted-printable`, `base64`, `7bit`, `8bit`, `binary`, or nothing. */
    readonly encoding?: string;
    /** `utf-8`, `iso-8859-1`, ... or nothing, which means UTF-8. */
    readonly charset?: string;
}

/** Undo the transfer encoding. Anything unrecognised is already bytes. */
function unwrap(bytes: Buffer, encoding: string | undefined): Buffer {
    switch ((encoding ?? "").trim().toLowerCase()) {
        case "quoted-printable":
            return decodeQuotedPrintable(bytes.toString("latin1"));
        case "base64":
            // A base64 part arrives wrapped at 76 characters, and the newlines
            // are not part of it.
            return Buffer.from(bytes.toString("ascii").replace(/\s+/g, ""), "base64");
        default:
            return bytes;
    }
}

/** Read the bytes as the character set the part declared. */
function asText(bytes: Buffer, charset: string | undefined): string {
    const named = (charset ?? "").trim().toLowerCase();
    if (!named || named === "utf-8" || named === "utf8" || named === "us-ascii" || named === "ascii") {
        return bytes.toString("utf8");
    }
    try {
        if (!iconv.encodingExists(named)) return bytes.toString("utf8");
        return iconv.decode(bytes, named);
    } catch {
        return bytes.toString("utf8");
    }
}

/** One part of a message, as text. */
export function decodePart(bytes: Buffer, part: PartEncoding): string {
    return asText(unwrap(bytes, part.encoding), part.charset);
}

/**
 * Undo the line wrapping a `format=flowed` message carries.
 *
 * A plain-text message sent that way ends every soft-wrapped line with a space,
 * so a paragraph arrives cut into 72-character pieces. Joining them back is what
 * stops a wall of ragged lines in the reading pane, and it must only join the
 * lines that end in a space - the ones that do not are where the author actually
 * pressed return.
 */
export function unflow(text: string, delSp = false): string {
    const out: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        const held = out.at(-1);
        // A line ending in a space is the sender saying "this continues", so the
        // next one belongs on the end of it. `delSp` is the sender saying the
        // space itself was only there to mark the break.
        if (held !== undefined && held.endsWith(" ")) {
            out[out.length - 1] = `${delSp ? held.slice(0, -1) : held}${line}`;
            continue;
        }
        out.push(line);
    }
    return out.join("\n");
}
