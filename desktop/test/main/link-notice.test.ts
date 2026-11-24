/**
 * BUG-0020: a link no route opened is said inside the window, never with the
 * system's alert box; the card only takes words shaped as the main process
 * sends them.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: {}, clipboard: {}, BrowserWindow: {}, app: {} }));

const { linkNotice } = await import("../../src/main/open-external");
const { readLinkNotice } = await import("../../src/preload/link-notice");

describe("readLinkNotice", () => {
    it("takes what the main process sends", () => {
        const words = linkNotice("https://github.com/x");
        expect(readLinkNotice(words)).toEqual(words);
    });

    it("refuses anything else", () => {
        for (const raw of [null, "x", { url: "javascript:alert(1)", title: "a", body: "b" }, { url: "https://a", title: 1, body: "b" }, { url: "https://a", title: "t".repeat(201), body: "b" }])
            expect(readLinkNotice(raw)).toBeNull();
    });
});
