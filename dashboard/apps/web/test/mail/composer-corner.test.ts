/**
 * Two panels, one corner.
 *
 * The mail composer docks into the bottom right, and the card that reports a
 * file being uploaded is fixed to the same place. They were both `z-40`, so the
 * moment somebody attached anything the progress card was drawn into the
 * composer - over the attachment strip it was reporting on and over the Send
 * button - with only the document order deciding which of the two won. Measured
 * in Chrome at three window sizes before this was written: 22,152 square pixels
 * of the composer covered on a laptop, the Send button under it every time.
 *
 * Read as source rather than rendered, for the same reason the cron routes are:
 * what is being checked is a pair of class strings that have to agree, and
 * importing the composer pulls the whole mail screen in to check two of them.
 */

import { join } from "node:path";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const composer = readFileSync(
    join(process.cwd(), "src/app/(app)/mail/composer.tsx"),
    "utf8"
);
const transfers = readFileSync(
    join(process.cwd(), "src/components/transfers/transfers-view.tsx"),
    "utf8"
);

/** The length a docked panel publishes, and the only thing the two share. */
const HEIGHT = "--docked-panel-height";

describe("the corner the composer and the transfer card share", () => {
    it("has the composer say how much of it it takes", () => {
        expect(composer).toContain(`setProperty(\n                "${HEIGHT}"`);
    });

    it("has the composer give it back", () => {
        // Twice: when it stops being docked, and when it unmounts. A length left
        // behind is every later upload floating in the middle of the screen.
        expect(composer.split(`removeProperty("${HEIGHT}")`)).toHaveLength(3);
    });

    it("stops publishing when the composer takes the whole screen", () => {
        // There is no room left to sit above, so the card stays where it is and
        // is drawn over it - which is why it is also on the layer above.
        expect(composer).toContain('posture === "full"');
    });

    it("sits above whatever is docked rather than on top of it", () => {
        expect(transfers).toContain(`var(${HEIGHT},0px)`);
        expect(transfers).toContain("z-50");
        expect(transfers).not.toContain("bottom-4 right-4 z-40");
    });

    it("writes the calc with the spaces CSS needs", () => {
        // The trap this cost an hour to: Tailwind turns underscores into spaces
        // in an arbitrary value, and `calc(1rem+var(...))` without them is not
        // valid CSS. The declaration is dropped in silence, the card loses its
        // `bottom` entirely, and it lands at the top of the page - which looks
        // like a different bug than the one being fixed.
        expect(transfers).toContain("calc(1rem_+_var(");
        expect(transfers).not.toMatch(/calc\(1rem\+var\(/);
    });

    it("keeps the composer under it, so the card is never the thing hidden", () => {
        expect(composer).toContain('"fixed z-40 flex flex-col');
    });
});
