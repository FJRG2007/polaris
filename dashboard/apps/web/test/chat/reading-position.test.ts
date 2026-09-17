// @vitest-environment jsdom

/**
 * A reader part way up a conversation stays on the line they are reading when
 * something above it changes height - a page of older messages arriving, or a
 * picture finishing loading. The list does this itself because it opts out of
 * the browser's scroll anchoring.
 */

import { afterEach, describe, expect, it } from "vitest";
import { keepReading, readingPosition } from "@/app/(app)/chat/reading-position";

/** A list whose rows sit at the given tops, each 50px tall, scrolled by `scrollTop`. */
function list(tops: Record<string, number>, scrollTop: number) {
    const scroller = document.createElement("div");
    scroller.scrollTop = scrollTop;
    const place = (element: HTMLElement, top: () => number, height: number) => {
        element.getBoundingClientRect = () =>
            ({
                top: top(),
                bottom: top() + height,
                left: 0,
                right: 0,
                width: 0,
                height
            }) as DOMRect;
    };
    place(scroller, () => 0, 500);
    for (const [id, top] of Object.entries(tops)) {
        const row = document.createElement("div");
        row.id = `message-${id}`;
        row.dataset.top = String(top);
        // Where a row is on screen depends on how far the list is scrolled.
        place(row, () => Number(row.dataset.top) - scroller.scrollTop, 50);
        scroller.append(row);
    }
    document.body.append(scroller);
    return scroller;
}

afterEach(() => {
    document.body.replaceChildren();
});

describe("the line a reader is on", () => {
    it("is the first message still on screen, and how far down it sits", () => {
        const scroller = list({ a: 0, b: 50, c: 100, d: 150 }, 120);
        expect(readingPosition(scroller)).toEqual({ id: "message-c", offset: 100 });
    });

    it("stays put when a page is added above it", () => {
        const scroller = list({ b: 50, c: 100 }, 110);
        const was = readingPosition(scroller);
        // Older messages arrive: everything already there moves down 400px.
        for (const row of scroller.children) {
            const element = row as HTMLElement;
            element.dataset.top = String(Number(element.dataset.top) + 400);
        }
        const kept = keepReading(scroller, was);
        expect(scroller.scrollTop).toBe(510);
        expect(readingPosition(scroller)).toEqual(kept);
        // Nothing moved since, so a second pass leaves the reader alone.
        keepReading(scroller, kept);
        expect(scroller.scrollTop).toBe(510);
    });

    it("does not change while the reader scrolls", () => {
        const scroller = list({ b: 50, c: 100 }, 110);
        const was = readingPosition(scroller);
        scroller.scrollTop = 130;
        keepReading(scroller, was);
        expect(scroller.scrollTop).toBe(130);
    });

    it("still catches height that arrived while the reader was scrolling", () => {
        const scroller = list({ b: 50, c: 100 }, 110);
        const was = readingPosition(scroller);
        // The reader scrolls up 20px and a picture above grows by 80px in the
        // same frame, before anything has been re-measured.
        scroller.scrollTop = 90;
        for (const row of scroller.children) {
            const element = row as HTMLElement;
            element.dataset.top = String(Number(element.dataset.top) + 80);
        }
        keepReading(scroller, was);
        expect(scroller.scrollTop).toBe(170);
    });

    it("is read again when the message left the window", () => {
        const scroller = list({ a: 0, b: 50 }, 10);
        const found = keepReading(scroller, { id: "message-gone", offset: 5 });
        expect(found).toEqual({ id: "message-a", offset: 0 });
        expect(scroller.scrollTop).toBe(10);
    });
});
