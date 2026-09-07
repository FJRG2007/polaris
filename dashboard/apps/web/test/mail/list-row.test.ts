/**
 * The right-click menu on a conversation opens.
 *
 * It did not, and nothing said so. The menu wraps each row in a Radix trigger
 * with `asChild`, which works by cloning the child element and handing it the
 * handler and the ref that make the menu open. The row was a component that
 * declared the props it wanted and dropped everything else, so both were thrown
 * away in silence - no error, no warning in the console, just a right-click that
 * did nothing on every conversation in the list.
 *
 * Asserted against the source because that is where the invariant lives and
 * where it will be lost: somebody tidies the parameter list, drops the rest
 * spread, and every test still passes while the feature is gone.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));

describe("a row carries what the menu hands it", () => {
    it("takes the props it was not told about and puts them on the element", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        const row = view.slice(view.indexOf("function ThreadRow("));
        expect(row).toContain("...rest");
        // On the element itself, and before `className`, so the row's own classes
        // are merged rather than overwritten by whatever is passed in.
        const element = row.slice(row.indexOf("<li"), row.indexOf("</li>"));
        expect(element).toContain("{...rest}");
        expect(element).toContain("rest.className");
    });

    it("is still what the menu wraps", async () => {
        const menu = await readFile(`${SCREENS}thread-menu.tsx`, "utf8");
        // If this stops using `asChild` the spread above is no longer load
        // bearing, and this test should be the thing that says so.
        expect(menu).toContain("<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>");
    });
});
