/**
 * The row above the notification history, and the search that had no room in it.
 *
 * The search was `flex-1` in a wrapping row it shared with three filters and two
 * buttons. Two of those filters are 10rem, one is 16rem, and the page they sit on
 * is 48rem - so `flex-1` was not "the rest of the line", it was whatever 36rem of
 * fixed width and two buttons had not already taken, which is a box a few
 * characters across. `min-w-0` then let it shrink the whole way there rather than
 * pushing anything onto the next line.
 *
 * A search is the widest thing on that row by use and was the narrowest by
 * layout, so it takes a line of its own and the filters wrap under it, where
 * there is room for them.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));
const view = readFile(`${SRC}app/(app)/account/notifications/notifications-view.tsx`, "utf8");

describe("the search box", () => {
    it("takes a line of its own rather than what is left of one", async () => {
        const source = await view;
        expect(source).toContain('<label className="relative w-full">');
    });

    it("is no longer sized by what the filters did not want", async () => {
        const source = await view;
        expect(source).not.toContain('className="relative min-w-0 flex-1 sm:max-w-xs"');
    });

    it("keeps the filters it was competing with", async () => {
        // The fix is where the search sits, not the loss of a filter: all three
        // are still there, on the line underneath.
        const source = await view;
        expect(source).toContain('aria-label="Filter by event"');
        expect(source).toContain('aria-label="Filter by state"');
        expect(source).toContain('aria-label="Order"');
    });
});
