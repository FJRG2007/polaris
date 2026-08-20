/**
 * The slice a range request asks for.
 *
 * A browser will not let anybody seek in a video the server did not offer ranges
 * for: the bar snaps back to where it was, which reads as a broken player rather
 * than as a missing header. Anything Polaris serves and draws a player around
 * has to answer this, so the reading of the header lives here rather than in the
 * route that happens to need it first.
 *
 * Only the one form is supported, and it is every form a media element sends: a
 * single range. A multipart range would need a multipart body, and no player has
 * ever asked for one. Anything unreadable is treated as no range at all rather
 * than as an error - the whole file is a correct answer to a request nobody
 * could parse, and refusing one a proxy invented would break playback outright.
 *
 * It needs the size, which is why the one route that streams footage straight
 * off a NAS parses its own: it does not know how big the file is until it has
 * opened it, and by then it has already had to decide where to start.
 */

/** Where a range starts and ends, both inclusive - or nothing to do. */
export interface ByteRange {
    readonly from: number;
    readonly to: number;
}

export function rangeOf(header: string | null, size: number): ByteRange | "unsatisfiable" | null {
    const asked = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? "");
    if (!asked) return null;
    const [, start, end] = asked;
    if (!start && !end) return null;

    // "the last n bytes", which is how a container's index is fetched.
    const from = start ? Number(start) : Math.max(0, size - Number(end));
    const to = start ? (end ? Math.min(Number(end), size - 1) : size - 1) : size - 1;
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to || from >= size) {
        return "unsatisfiable";
    }
    return { from, to };
}
