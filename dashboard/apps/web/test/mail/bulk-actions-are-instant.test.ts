/**
 * Several conversations picked and marked read change at once, and go back if
 * the server says no.
 *
 * The rows already moved under an overlay. What still waited was everything
 * around them: the selection stayed ticked and the toolbar stayed "3 picked"
 * with every button greyed out until the mail server answered, which read as
 * the action not having happened. Snoozing and labelling did not move the rows
 * at all, the reading pane's star and unread waited for the server, and a
 * request that threw put the rows back without a word.
 *
 * The overlay and its rollback are run here; the screen wiring is asserted
 * against the source, in the shape of the rule, because running it would prove
 * a mock was called.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { refusalOrFailure } from "@/app/(app)/mail/refusal";
import { afterEach, describe, expect, it, vi } from "vitest";
import { optimistically } from "@/app/(app)/mail/optimistic";
import {
    beginChange,
    overlaysFor,
    pendingChanges,
    resetPendingChanges
} from "@/app/(app)/mail/pending-changes";

const SCREENS = fileURLToPath(new URL("../../src/app/(app)/mail/", import.meta.url));
const source = (name: string) => readFile(`${SCREENS}${name}`, "utf8");

afterEach(() => resetPendingChanges());

describe("a bulk mark-read", () => {
    it("is drawn on every picked row at once, and taken off them all on a refusal", () => {
        const picked = ["t1", "t2", "t3"];
        const pending = beginChange(picked, optimistically("read")!);
        const drawn = overlaysFor(pendingChanges(), 0, Date.now());
        for (const id of picked) expect(drawn[id]).toEqual({ unreadCount: 0 });

        pending.abandon();
        expect(overlaysFor(pendingChanges(), 0, Date.now())).toEqual({});
    });

    it("stays drawn over a list asked for before the server agreed", () => {
        const pending = beginChange(["t1", "t2"], { unreadCount: 0 });
        const askedBefore = Date.now() - 1;
        pending.settle();
        expect(overlaysFor(pendingChanges(), askedBefore, Date.now()).t2).toEqual({
            unreadCount: 0
        });
    });

    it("lays a label on a row beside the ones it has, and takes only that off", () => {
        const kept = { id: "l1", name: "Work", color: "#000" };
        const added = { id: "l2", name: "Later", color: "#fff" };
        const pending = beginChange(["t1"], { labels: [kept, added] });
        expect(overlaysFor(pendingChanges(), 0, Date.now()).t1?.labels).toEqual([kept, added]);
        pending.abandon();
        expect(overlaysFor(pendingChanges(), 0, Date.now()).t1).toBeUndefined();
    });
});

describe("what a failed change says", () => {
    it("is the server's sentence when it refused", async () => {
        expect(await refusalOrFailure(Promise.resolve({ error: "No such folder" }), "x")).toBe(
            "No such folder"
        );
    });

    it("is nothing when it held", async () => {
        expect(await refusalOrFailure(Promise.resolve({ done: 3 }), "x")).toBe("");
    });

    it("is the fallback when nothing answered at all", async () => {
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await refusalOrFailure(Promise.reject(new Error("socket")), "Try again")).toBe(
            "Try again"
        );
        quiet.mockRestore();
    });
});

describe("the list screen", () => {
    it("lets the selection go with the press and puts it back on a refusal", async () => {
        const view = await source("mail-view.tsx");
        const act = view.slice(
            view.indexOf("const act = useCallback("),
            view.indexOf("const fileMail")
        );
        // Cleared before the server is asked, not after it answers.
        expect(act.indexOf("setSelected([])")).toBeLessThan(act.indexOf("startBusy("));
        expect(act).toMatch(/const putBack = \(\) => \{[\s\S]*?setSelected\(/);
        // A request that throws is said, not only logged.
        expect(act).toContain('toast.show({ title: t("list.changeFailed") })');
    });

    it("takes snoozed rows out at once, with their unread", async () => {
        const view = await source("mail-view.tsx");
        const snooze = view.slice(view.indexOf("const snooze = useCallback("));
        const body = snooze.slice(0, snooze.indexOf("startBusy("));
        expect(body).toContain("patchUntilAnswered(aimed, { gone: true })");
        expect(body).toContain("nudgeUnread(");
    });

    it("puts a label on the rows before the server answers", async () => {
        const view = await source("mail-view.tsx");
        const label = view.slice(view.indexOf("const label = useCallback("));
        expect(label.slice(0, label.indexOf("startBusy("))).toContain(
            "patchUntilAnswered([id], { labels:"
        );
    });

    it("says how many are picked through the catalogue", async () => {
        expect(await source("mail-view.tsx")).not.toMatch(/\{selected\.length\} picked/);
    });
});

describe("the reading pane", () => {
    it("shows a star, unread, pin or label before the server answers", async () => {
        const pane = await source("thread-view.tsx");
        expect(pane).toContain("leaving ? onGone?.() : onChange?.(action)");
        expect(pane).toMatch(/const answered = onChange\?\.\(state\)/);
        expect(pane).toMatch(/onChange\?\.\(\{ labels: \[\.\.\.thread\.labels, label\] \}\)/);
        const view = await source("mail-view.tsx");
        expect(view).toMatch(
            /onChange=\{\(change\) => \{[\s\S]*?patchUntilAnswered\(\[openThread\.id\], patch\)/
        );
    });
});
