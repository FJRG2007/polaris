/**
 * Throwing away the conversation you are reading.
 *
 * A regression test for the worst kind of break there is: the screen was not
 * wrong afterwards, it was gone. Trashing the open conversation replaced the
 * whole mail app with the not-found page.
 *
 * Two halves cause it, and both are asserted here because either one alone puts
 * it back.
 *
 * **The server half.** Every move - archive, trash, spam, delete - drops the
 * message rows: the destination folder decides the uids and they are fetched
 * again rather than guessed at. So the conversation the address still names has
 * no messages a moment later, and the page answered that with `notFound()`.
 *
 * **The client half.** Nothing took the conversation out of the address when it
 * was moved, so the next render asked for it again. Even with the 404 gone that
 * leaves a pane saying the conversation is no longer here, beside a list it is no
 * longer in - which is the same defect, quieter.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { leavesTheView } from "@/app/(app)/mail/mail-actions";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));

describe("which actions take a conversation out of the view", () => {
    it("names every move, because every move drops the rows", () => {
        for (const action of ["archive", "trash", "delete", "junk", "not-junk", "inbox"] as const) {
            expect(leavesTheView(action), action).toBe(true);
        }
    });

    it("leaves the flags alone, so reading one does not close it", () => {
        // These are the four that set a flag in place. Closing the pane on them
        // would mean starring a message you are reading threw you out of it.
        for (const action of ["read", "unread", "star", "unstar"] as const) {
            expect(leavesTheView(action), action).toBe(false);
        }
    });
});

describe("the page survives a conversation that is not there", () => {
    it("never answers a missing one with the not-found page", async () => {
        const page = await readFile(`${SCREENS}list-page.tsx`, "utf8");
        // Deliberately the whole file: `notFound` belongs on the routes whose own
        // subject is missing - a mailbox, a folder, a label - and never on the
        // conversation the address happens to name, which is somebody's mail
        // having been filed rather than the page not existing.
        expect(page).not.toContain("notFound");
    });

    it("draws the list with nothing open rather than falling over", async () => {
        const page = await readFile(`${SCREENS}list-page.tsx`, "utf8");
        // The fallback conversation is built only when there are messages to
        // build it from. Reaching `openMessages[0]!` unguarded is the crash this
        // guards, and it is one edit away.
        expect(page).toContain("if (wanted && !openThread && openMessages.length > 0)");
    });
});

describe("the address stops naming what was moved", () => {
    it("closes the pane from the list", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view).toContain('url.searchParams.delete("open")');
        // Replaced, not pushed: Back into a conversation that has been filed is a
        // step that leads nowhere.
        expect(view).toMatch(/router\.replace\(`\$\{path\}\$\{url\.search\}`/);
        // A link straight to a conversation names it in the path instead, where
        // there is nothing to strip - the way out is the list.
        expect(view).toContain('url.pathname.startsWith("/mail/t/")');
        expect(view).toContain("leavesTheView(action) && openThread && aimed.includes(openThread.id)");
    });

    it("closes the pane from the conversation's own header", async () => {
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        expect(thread).toContain("if (leavesTheView(action)) {");
        expect(thread).toContain("onGone?.();");
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        // And the list is what it is told to do, or the pane calls into nothing.
        expect(view).toContain("onGone={closeOpen}");
    });

    /**
     * Closing the pane is a navigation, and asking the router to refresh in the
     * same breath is a second fetch racing it - the navigation is the one that
     * loses. That is what left the address still naming a deleted conversation,
     * with the next click on another one apparently doing nothing until the page
     * was reloaded.
     */
    it("does not refresh over the navigation that closes it", async () => {
        for (const screen of ["thread-view.tsx", "mail-view.tsx"]) {
            const source = await readFile(`${SCREENS}${screen}`, "utf8");
            const closing = source.slice(source.indexOf("leavesTheView(action)"));
            const stop = closing.indexOf("return;");
            expect(stop, `${screen} carries on past closing the pane`).toBeGreaterThan(0);
            expect(closing.slice(0, stop)).not.toContain("refresh()");
        }
    });
});
