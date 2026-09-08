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
const MAILBOX = fileURLToPath(new URL("../../src/lib/mailbox/", import.meta.url));

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
        // The row is built from the conversation's own messages, which is what
        // makes a link to a filed conversation open at all - and it is built only
        // when there are messages to build it from. Reaching `messages[0]!`
        // unguarded is the crash this guards, and it is one edit away.
        const views = await readFile(`${MAILBOX}views.ts`, "utf8");
        expect(views).toContain(
            "if (messages.length === 0) return { thread: null, messages: [] };"
        );

        // And the client half: a conversation the list does not have still opens
        // from its own answer, rather than the screen deciding there is nothing
        // to show.
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view).toContain("?? opened.answer?.thread ?? null");
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
        expect(view).toContain(
            "leavesTheView(action) && openThread !== null && aimed.includes(openThread.id)"
        );
    });

    it("closes the pane from the conversation's own header", async () => {
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        expect(thread).toContain("const leaving = leavesTheView(action);");
        expect(thread).toContain("onGone?.();");
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        // And the list is what it is told to do, or the pane calls into nothing.
        // Which of the two it does is the reader's own answer - back to the list,
        // or straight on to the next conversation - and both are still the list
        // acting on being told.
        expect(view).toContain('preferences.afterFiling === "next"');
        expect(view).toContain("openNext([openThread.id]);");
        expect(view).toContain("else closeOpen();");
        // And the row goes from the list in the same breath. Without it the
        // conversation somebody just deleted sits in the list beside the empty
        // space where they were reading it, which reads as nothing having
        // happened.
        expect(view).toContain("patchUntilAnswered([openThread.id], { gone: true })");
    });

    it("closes it before the mail server answers, and puts it back if it refuses", async () => {
        // Filing a message is a round trip to somebody else's IMAP server. Waiting
        // for it read as a button that had not been pressed: the reader sat inside
        // a message they had just deleted, in a list whose row had already gone,
        // watching nothing happen.
        const thread = await readFile(`${SCREENS}thread-view.tsx`, "utf8");
        const act = thread.slice(thread.indexOf("const act = useCallback"));
        const leaves = act.indexOf("if (leaving) onGone?.();");
        const asks = act.indexOf("startBusy(");
        expect(leaves, "the pane closes inside the action").toBeGreaterThan(0);
        expect(leaves, "the pane closes before the server is asked").toBeLessThan(asks);
        // And the other half, without which leaving early is a lie: a refusal puts
        // the reader back where they were.
        expect(act).toContain("if (leaving) onStayed?.();");

        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        expect(view).toContain("openAgain(openThread.id);");
        // Both halves go back on a refusal, not only the reader.
        expect(view).toContain("clearPatches();");
        expect(view).toContain('url.searchParams.set("open", threadId)');
    });

    it("keeps the row hidden while the list it left comes back unchanged", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        // Closing the pane is a navigation, and these routes are dynamic: a
        // fresh list arrives in a few tens of milliseconds with the row still in
        // it, seconds before the mail server has moved anything. Clearing every
        // overlay on a new list put the conversation somebody had just deleted
        // back on screen for as long as the delete took - which is the one
        // moment the overlay exists for.
        expect(view).toContain("setPatched(inFlight.current);");
        expect(view).toContain("patchUntilAnswered(aimed, ahead)");
        // And dropped as soon as the answer is in, either way, so the screen
        // never disagrees with the mailbox for longer than the action takes.
        expect(view).toContain("inFlight.current = {};");
    });

    /**
     * Two things are true at once here, and the second only became true when the
     * list stopped being the server's.
     *
     * Closing the pane is a navigation, and a router refresh in the same breath
     * is a second fetch racing it - the navigation is the one that loses, which
     * left the address still naming a conversation that had been deleted. But
     * the navigation does not re-read the list any more: the list is fetched by
     * the browser against the narrowing, and dropping `?open=` does not change
     * the narrowing, so nothing was re-read and the row somebody had just
     * deleted sat there until they reloaded the page.
     *
     * So: pull the data, leave the router alone.
     */
    it("pulls the list but leaves the router alone on the path that navigates", async () => {
        for (const screen of ["thread-view.tsx", "mail-view.tsx"]) {
            const source = await readFile(`${SCREENS}${screen}`, "utf8");
            // The branch AFTER the server answered, which is the one that
            // decides what to re-read - not the earlier one that closes the pane.
            const answered = source.slice(source.indexOf("const outcome = await actOnAction"));
            const closing = answered.slice(answered.indexOf("if (leaving) {"));
            const stop = closing.indexOf("return;");
            expect(stop, `${screen} carries on past closing the pane`).toBeGreaterThan(0);
            const inside = closing.slice(0, stop);
            expect(inside, `${screen} must pull the list`).toContain("reloadLists()");
            expect(inside, `${screen} must not refresh the router`).not.toContain("refresh()");
        }
    });

    it("keeps the row hidden while the list it left comes back unchanged", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        // Closing the pane is a navigation, and these routes are dynamic: a
        // fresh list arrives in a few tens of milliseconds with the row still in
        // it, seconds before the mail server has moved anything. Clearing every
        // overlay on a new list put the conversation somebody had just deleted
        // back on screen for as long as the delete took - which is the one
        // moment the overlay exists for.
        expect(view).toContain("setPatched(inFlight.current);");
        expect(view).toContain("patchUntilAnswered(aimed, ahead)");
        // And dropped as soon as the answer is in, either way, so the screen
        // never disagrees with the mailbox for longer than the action takes.
        expect(view).toContain("inFlight.current = {};");
    });

});
