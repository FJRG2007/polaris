/**
 * Answering the request a player makes when somebody drags the bar.
 *
 * A browser will not let anybody seek in a video the server did not offer ranges
 * for: the bar snaps back to where it was, which reads as a broken player rather
 * than as a missing header. Polaris serves clips people record in the composer,
 * so this is the difference between a feature and a thing that half works.
 *
 * The parsing is what is tested, because every failure in it is silent and
 * plausible. A slice one byte short truncates the last frame; an open-ended
 * range read as zero serves nothing at all and the video simply stops; a suffix
 * range - "the last n bytes", which is how a container's index is fetched - read
 * as an offset serves the wrong end of the file and the player never learns how
 * long it is.
 */

import { describe, expect, it } from "vitest";
import { rangeOf } from "@/lib/http-range";

const SIZE = 1000;

describe("what a player asks for", () => {
    it("takes a window with both ends named", () => {
        expect(rangeOf("bytes=0-499", SIZE)).toEqual({ from: 0, to: 499 });
        expect(rangeOf("bytes=500-999", SIZE)).toEqual({ from: 500, to: 999 });
    });

    it("reads an open end as the end of the file", () => {
        // What every media element sends first: "from here on".
        expect(rangeOf("bytes=200-", SIZE)).toEqual({ from: 200, to: 999 });
    });

    it("reads a suffix as the last bytes, not the first", () => {
        // How a container's index is fetched, and the one that is silently wrong
        // in the other direction: serving the head instead means the player
        // never finds the index and never knows the duration.
        expect(rangeOf("bytes=-100", SIZE)).toEqual({ from: 900, to: 999 });
    });

    it("never runs past the end, however much is asked for", () => {
        expect(rangeOf("bytes=900-5000", SIZE)).toEqual({ from: 900, to: 999 });
        expect(rangeOf("bytes=-5000", SIZE)).toEqual({ from: 0, to: 999 });
    });

    it("refuses a window that starts past the end", () => {
        expect(rangeOf("bytes=1000-", SIZE)).toBe("unsatisfiable");
        expect(rangeOf("bytes=800-700", SIZE)).toBe("unsatisfiable");
    });

    it("treats anything it cannot read as no range at all", () => {
        // The whole file is a correct answer to a request nobody could parse,
        // and a 416 for a header a proxy invented would break playback outright.
        for (const header of [null, "", "bytes=", "items=0-10", "bytes=abc-def", "bytes=0-1,5-6"]) {
            expect(rangeOf(header, SIZE)).toBeNull();
        }
    });
});
