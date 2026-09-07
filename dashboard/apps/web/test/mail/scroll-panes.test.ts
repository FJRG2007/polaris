/**
 * The two panes of Mail scroll apart.
 *
 * A regression test for a bug that is invisible in review and obvious the moment
 * anybody uses the app: the list and the open message shared one scrollbar, so
 * reading a long message dragged the conversation list with it.
 *
 * The cause is a CSS rule nobody remembers. A flex item's minimum size is its
 * CONTENT size unless it says `min-h-0`, so an `overflow-y-auto` inside a flex
 * child never becomes shorter than what it holds - it grows the column instead,
 * the scroll escapes to whatever contains both panes, and one scrollbar moves
 * everything.
 *
 * Asserted against the source rather than a rendered page because that is where
 * the invariant lives and where it will be broken: somebody rewrites a class
 * list, drops `min-h-0`, and nothing tells them until a person scrolls. A test
 * that needed a browser would not be run.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));

/** The class list of the element carrying an `aria-label` in a file. */
function classesNear(source: string, marker: string): string {
    // The className block is written above the aria-label on both panes, so the
    // slice between the previous "<section" and the marker holds it.
    const at = source.indexOf(marker);
    expect(at, `${marker} is no longer in the file`).toBeGreaterThan(-1);
    const opens = source.lastIndexOf("<section", at);
    return source.slice(opens, at);
}

describe("the list and the message own their own scrollbars", () => {
    it("bounds both panes, so neither drags the other", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");

        // The conversation list.
        const list = classesNear(view, "aria-label={context.title}");
        expect(list).toContain("min-h-0");
        // The reading pane.
        const reading = classesNear(view, 'aria-label="Conversation"');
        expect(reading).toContain("min-h-0");
    });

    it("keeps a scrolling region inside each of them", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        // One in the list for the rows, one in the reading pane for the messages.
        // Without these the panes are bounded and nothing scrolls at all, which
        // is the other half of the same mistake.
        expect(view).toContain("min-h-0 flex-1 overflow-y-auto");
        expect(thread).toContain("min-h-0 flex-1 overflow-y-auto");
    });

    it("holds the headers still while the rows move under them", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        // A header that can be squeezed is one that shrinks as the list grows,
        // which reads as the toolbar drifting away while you scroll.
        expect(view).toMatch(/<header className="flex shrink-0 /);
        expect(thread).toMatch(/<header className="flex shrink-0 /);
    });
});
