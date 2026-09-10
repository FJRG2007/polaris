/**
 * Turning a container's log output into lines, the same way for every reader.
 *
 * Output arrives in chunks that end wherever the pipe happened to flush, so a
 * line can straddle two of them; a reader that split each chunk on its own would
 * print half a line and then the other half as a line of its own. The splitter
 * holds the unfinished tail until the rest of it arrives.
 *
 * Every line is read with `--timestamps`, so it starts with docker's own
 * RFC 3339 stamp to the nanosecond. That stamp is what orders lines from several
 * replicas into one stream, and what tells the capture job which lines it has
 * already kept: the text form sorts the same way the time does, to the digit.
 *
 * Pure, so the rules are asserted in tests rather than found out in production.
 */

import { StringDecoder } from "node:string_decoder";

/** Longest line kept. A line longer than this is almost always a minified bundle
 *  or a base64 blob printed by mistake, and the start of it says what it is. */
export const MAX_LINE_CHARS = 4096;

/** docker's stamp: fixed width once the fraction is padded, and always UTC. */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z) ?(.*)$/;

export interface StampedLine {
    /** The stamp as docker wrote it, fraction padded to nine digits so two
     *  stamps compare as strings exactly as they compare as times. Null for a
     *  line that carries none. */
    readonly stamp: string | null;
    readonly text: string;
}

/** A stamp with its fraction padded to nanoseconds, so text order is time order. */
export function normalizeStamp(stamp: string): string {
    const match = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(stamp);
    if (!match) return stamp;
    return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`;
}

/** A NUL byte, which a text column refuses outright - one in a batch fails the
 *  whole insert, and the next capture reads the same tail and fails again. */
const NUL = String.fromCharCode(0);

/** Split docker's stamp off a line, and cut the rest to the kept length. */
export function splitStamp(line: string): StampedLine {
    const clean = line.replace(/\r$/, "").split(NUL).join("");
    const match = STAMP_RE.exec(clean);
    const text = (match ? (match[2] ?? "") : clean).slice(0, MAX_LINE_CHARS);
    return { stamp: match ? normalizeStamp(match[1] ?? "") : null, text };
}

/** The moment a normalized stamp names, to the millisecond a Date holds. */
export function stampDate(stamp: string): Date {
    return new Date(stamp.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
}

/** Collects chunks into whole lines, holding a trailing partial line back. */
export class LineSplitter {
    private held = "";
    // Decoded across chunks: a character of more than one byte can be split by
    // the pipe as easily as a line can, and decoding each chunk on its own turns
    // it into two replacement marks.
    private readonly decoder = new StringDecoder("utf8");

    /** The whole lines this chunk completes. */
    public push(chunk: Buffer | string): string[] {
        const text = this.held + (typeof chunk === "string" ? chunk : this.decoder.write(chunk));
        const parts = text.split("\n");
        this.held = parts.pop() ?? "";
        // A line that never ends is still bounded: past the kept length it is
        // emitted in pieces rather than held until memory runs out.
        if (this.held.length > MAX_LINE_CHARS * 4) {
            parts.push(this.held);
            this.held = "";
        }
        return parts.filter((part) => part.length > 0);
    }

    /** Whatever was held back when the stream ended. */
    public flush(): string[] {
        const rest = this.held + this.decoder.end();
        this.held = "";
        return rest ? [rest] : [];
    }
}

/**
 * The lines of a tail that come after `after`, oldest first.
 *
 * Strictly after: a line whose stamp equals the last one kept is the last one
 * kept. Two lines printed in the same nanosecond are vanishingly rare and would
 * be the price of never storing a line twice. Unstamped lines are dropped here -
 * without a stamp there is no way to tell a new one from a copy.
 */
export function linesAfter(lines: readonly StampedLine[], after: string | null): StampedLine[] {
    return lines
        .filter((line): line is StampedLine & { stamp: string } => line.stamp !== null)
        .filter((line) => after === null || line.stamp > after)
        .sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
}
