/**
 * Picking conversations the way every list of anything is picked.
 *
 * Shift for a run, the modifier and A for all of them, Escape to let go. None of
 * the three worked, which meant filing fifty newsletters was fifty clicks.
 *
 * The run is the part with logic in it, so it is a function and tested here. The
 * other two are bindings, and asserted against the source the way the rest of
 * this screen's invariants are - they are one tidy-up away from being lost and
 * nothing else would say so.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runBetween } from "@/app/(app)/mail/mail-actions";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));
const ROWS = ["a", "b", "c", "d", "e"];

describe("the run between two rows", () => {
    it("takes everything between them, both ends included", () => {
        expect(runBetween(ROWS, "b", "d")).toEqual(["b", "c", "d"]);
    });

    it("reads the same run upwards", () => {
        // Shift-clicking above the anchor is the same gesture, and a list that
        // only worked downwards would be one people stop trusting.
        expect(runBetween(ROWS, "d", "b")).toEqual(["b", "c", "d"]);
    });

    it("is one row when both ends are the same", () => {
        expect(runBetween(ROWS, "c", "c")).toEqual(["c"]);
    });

    it("falls back to the row that was clicked when the anchor has gone", () => {
        // The list is redrawn from the server between two clicks - a sync lands,
        // a message arrives - so the row somebody anchored on can be off the
        // page by the time they shift-click. A plain pick is the safe answer.
        expect(runBetween(ROWS, "zz", "c")).toEqual(["c"]);
        expect(runBetween(ROWS, "", "c")).toEqual(["c"]);
    });

    it("picks nothing at all rather than throwing on an empty list", () => {
        expect(runBetween([], "a", "b")).toEqual(["b"]);
        expect(runBetween(ROWS, "a", "")).toEqual([]);
    });
});

describe("the gestures a list owns", () => {
    it("binds select-all and lets go on Escape", async () => {
        const keys = await readFile(`${SCREENS}use-mail-keys.ts`, "utf8");
        // The one chord here, handled before the bail that leaves the browser's
        // own chords alone - which is where it used to be swallowed.
        expect(keys).toContain('event.key.toLowerCase() === "a"');
        expect(keys).toContain("return run(now.selectAll);");
        // Escape undoes the nearest thing first: the selection, then the
        // conversation being read.
        expect(keys).toContain("if (now.clearSelection?.())");
    });

    it("deletes on the key somebody who has never used a mail client presses", async () => {
        const keys = await readFile(`${SCREENS}use-mail-keys.ts`, "utf8");
        expect(keys).toContain('case "Delete":');
        expect(keys).toContain('case "Backspace":');
        expect(keys).toContain('case "#":');
    });

    it("reads the modifier off the click rather than tracking it", async () => {
        const view = await readFile(`${SCREENS}mail-view.tsx`, "utf8");
        // Tracking shift ourselves is wrong every time somebody alt-tabs away
        // holding it down.
        expect(view).toContain("shiftKey");
    });
});

describe("what the right-click menu offers", () => {
    it("says which key does the same thing", async () => {
        const menu = await readFile(`${SCREENS}thread-menu.tsx`, "utf8");
        for (const keys of ['keys="r"', 'keys="f"', 'keys="e"', 'keys="Delete"', 'keys="!"']) {
            expect(menu, keys).toContain(keys);
        }
    });

    it("draws the two that take mail away as what they are", async () => {
        const menu = await readFile(`${SCREENS}thread-menu.tsx`, "utf8");
        const danger = menu.split('variant="danger"').length - 1;
        // Report as spam and Move to trash. Archive is not one of these: it is
        // where mail goes to be kept.
        expect(danger).toBe(2);
    });

    it("can answer a conversation without opening it", async () => {
        const menu = await readFile(`${SCREENS}thread-menu.tsx`, "utf8");
        expect(menu).toContain('onAnswer("reply", thread.leadMessageId)');
        expect(menu).toContain('onAnswer("reply-all", thread.leadMessageId)');
        expect(menu).toContain('onAnswer("forward", thread.leadMessageId)');
    });

    it("can go and find everything else from one sender", async () => {
        const menu = await readFile(`${SCREENS}thread-menu.tsx`, "utf8");
        expect(menu).toContain("SEARCH_FOR(sender)");
        // A search rather than a filter, so it lands somewhere with an address
        // bar that can be edited and kept.
        expect(menu).toContain("/mail?q=");
    });
});
