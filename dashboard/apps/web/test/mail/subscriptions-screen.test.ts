/**
 * The Subscriptions screen, which is a page rather than a list.
 *
 * Two things were wrong with it and both come from the same place: it is not a
 * list of conversations, and Mail's shell assumed anything that was not
 * settings was.
 *
 * **It could not be scrolled.** A list of conversations owns its own scrollbar,
 * so the area holding it has `overflow-hidden` - and the area asked whether the
 * path was under `/mail/settings`. Subscriptions is not, so every sender past
 * the bottom of the window was unreachable.
 *
 * **And it did not say which mailbox a sender writes to.** It did, at the end of
 * a line that truncates, which is the first thing to go on exactly the rows long
 * enough to need it. Somebody with two mailboxes could not tell one list from
 * another.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src/", import.meta.url));

describe("what scrolls", () => {
    it("is decided by what IS a list rather than by what is not", async () => {
        const shell = await readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");
        expect(shell).toContain("const listing =");
        expect(shell).toContain(
            'listing ? "overflow-hidden" : "overflow-y-auto overscroll-contain"'
        );
        // The old question, which is what left this screen cut off.
        expect(shell).not.toContain("const inSettings =");
    });

    it("knows the merged views from the table the routes are built from", async () => {
        // A view added there is a list here without anybody saying so twice.
        const shell = await readFile(`${SRC}app/(app)/mail/mail-shell.tsx`, "utf8");
        expect(shell).toContain(
            "const MAIL_VIEW_PATHS = new Set(Object.keys(MAIL_VIEWS).map((view) => `/mail/${view}`));"
        );
    });
});

describe("which mailbox a sender writes to", () => {
    it("is on a line of its own rather than at the end of one that truncates", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/subscriptions/subscriptions-view.tsx`,
            "utf8"
        );
        expect(view).not.toContain("` - to ${mailbox}`");
        expect(view).toContain("to {mailbox}");
    });

    it("wears the mailbox's own colour, so the row and the rail agree", async () => {
        const view = await readFile(
            `${SRC}app/(app)/mail/subscriptions/subscriptions-view.tsx`,
            "utf8"
        );
        expect(view).toContain("const { accounts, accountColor } = useMail();");
        expect(view).toContain("colour={accountColor(one.accountId)}");
        expect(view).toContain("style={{ backgroundColor: colour }}");
    });

    it("says nothing at all to somebody with one mailbox", async () => {
        // The answer to a question nobody asked.
        const view = await readFile(
            `${SRC}app/(app)/mail/subscriptions/subscriptions-view.tsx`,
            "utf8"
        );
        expect(view).toContain("accounts.length > 1");
        expect(view).toContain("{mailbox ? (");
    });
});
