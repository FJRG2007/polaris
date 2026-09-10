/**
 * The mail app is as tall as the window, and not one pixel taller.
 *
 * The bug this exists for: the whole page had a scrollbar, behind the list that
 * was supposed to be doing the scrolling. `PAGE_BLEED` fixes the height to what
 * is left of the window, and the shell added `h-full` after it - which is
 * `height: 100%` of a parent that has no height of its own, so it resolves to
 * auto and the app grows to the height of its own content.
 *
 * What makes it invisible in review is the merge. Two Tailwind classes for one
 * property do not resolve by the order they are written in the attribute; `cn`
 * runs them through tailwind-merge, which DROPS the earlier one entirely. So the
 * shell's class list did not contain a height at all, and nothing in the source
 * said so.
 *
 * Asserted against the real merge rather than against the source, because the
 * merge is the part that surprises people.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { cn, PAGE_BLEED } from "@polaris/ui";
import { describe, expect, it } from "vitest";

const SHELL = fileURLToPath(new URL("../../src/app/(app)/mail/mail-shell.tsx", import.meta.url));

describe("what the shell's class list actually resolves to", () => {
    it("keeps the height PAGE_BLEED sets", () => {
        const merged = cn(PAGE_BLEED, "flex min-h-0 overflow-hidden");
        expect(merged).toContain("h-[calc(100vh-var(--header-height))]");
    });

    it("loses it to anything that also sets a height", () => {
        // The mechanism, spelled out. `h-full` is not an addition to PAGE_BLEED;
        // it replaces the one thing PAGE_BLEED is for.
        const merged = cn(PAGE_BLEED, "flex h-full min-h-0 overflow-hidden");
        expect(merged).not.toContain("h-[calc(");
        expect(merged).toContain("h-full");
    });
});

describe("the window under a screen like this", () => {
    it("never scrolls, whatever else lands on the page", async () => {
        // Measured in Chrome with the real chrome and CSS: anything that adds
        // height outside the screen (a banner, a notice) let one wheel move the
        // window and every pane on it together. The marker survives the merge,
        // and the root rule stops the window scrolling while it is on the page.
        expect(cn(PAGE_BLEED, "flex min-h-0 overflow-hidden").split(" ")).toContain("page-bleed");
        const tokens = await readFile(
            fileURLToPath(
                new URL("../../../../packages/ui/src/styles/tokens.css", import.meta.url)
            ),
            "utf8"
        );
        expect(tokens).toMatch(/html:has\(\.page-bleed\) \{\s*overflow: hidden;/);
    });
});

describe("the shell itself", () => {
    it("does not set a height beside PAGE_BLEED", async () => {
        const source = await readFile(SHELL, "utf8");
        const line = source.split("\n").find((one) => one.includes("cn(PAGE_BLEED"));
        expect(line, "the shell no longer uses PAGE_BLEED").toBeTruthy();
        expect(line).not.toMatch(/\bh-(?:full|screen|\[)/);
        // And it still clips, or its children's own scrolling has nothing to be
        // bounded by.
        expect(line).toContain("min-h-0");
    });
});
