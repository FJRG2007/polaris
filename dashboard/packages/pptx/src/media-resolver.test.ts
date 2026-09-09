/**
 * That a deck decodes its own logo once.
 *
 * A template's picture is referenced by every page it appears on, and resolving
 * one means reading it out of the archive, sniffing its container, scrubbing it
 * and base64-ing it. A cache that lives no longer than a page does all of that
 * again on the next one - which on a long deck is the difference between a deck
 * opening and a deck appearing to hang, and it is invisible from the outside
 * because the answer is correct either way.
 *
 * The one thing that genuinely does depend on the page is an Office-themed SVG:
 * it resolves against the colour scheme of the slide it sits on, and two pages
 * can sit on different layouts. So those are keyed by the page as well, and this
 * pins both halves of that.
 */

import type { OpenedPptx } from "./index";
import { describe, expect, it } from "vitest";
import { makeMediaResolvers } from "./media-resolver";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const THEMED_SVG = new TextEncoder().encode(
    '<svg xmlns="http://www.w3.org/2000/svg"><style>.MsftOfcThm_accent1_Fill{fill:#000}</style></svg>'
);

/** An archive holding two parts, counting what is read out of it. */
function archiveOf(parts: Record<string, Uint8Array>): { opened: OpenedPptx; reads: () => number } {
    let reads = 0;
    const opened = {
        deck: { slides: [] },
        archive: {
            readBytes: (ref: string) => {
                reads += 1;
                return parts[ref] ?? null;
            },
            readText: () => null,
            resolveSlideChain: () => ({})
        }
    } as unknown as OpenedPptx;
    return { opened, reads: () => reads };
}

describe("resolving a deck's media", () => {
    it("reads a picture once however many pages carry it", () => {
        const { opened, reads } = archiveOf({ "ppt/media/logo.png": PNG });
        const media = makeMediaResolvers(opened);
        const first = media("ppt/slides/slide1.xml")("ppt/media/logo.png");
        const second = media("ppt/slides/slide2.xml")("ppt/media/logo.png");
        const third = media("ppt/slides/slide3.xml")("ppt/media/logo.png");
        expect(first).toMatch(/^data:image\/png;base64,/);
        expect(second).toBe(first);
        expect(third).toBe(first);
        expect(reads()).toBe(1);
    });

    it("resolves a themed SVG once per page, because its colours are the page's", () => {
        const { opened, reads } = archiveOf({ "ppt/media/mark.svg": THEMED_SVG });
        const media = makeMediaResolvers(opened);
        const onFirst = media("ppt/slides/slide1.xml");
        const onSecond = media("ppt/slides/slide2.xml");
        expect(onFirst("ppt/media/mark.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(onSecond("ppt/media/mark.svg")).toMatch(/^data:image\/svg\+xml;base64,/);
        expect(reads()).toBe(2);
        // And not again on a page it has already been resolved for.
        onFirst("ppt/media/mark.svg");
        onSecond("ppt/media/mark.svg");
        expect(reads()).toBe(2);
    });

    it("answers nothing for a picture the deck names and does not carry", () => {
        const { opened, reads } = archiveOf({});
        const media = makeMediaResolvers(opened);
        expect(media("ppt/slides/slide1.xml")("ppt/media/gone.png")).toBeUndefined();
        media("ppt/slides/slide2.xml")("ppt/media/gone.png");
        expect(reads()).toBe(1);
    });
});
