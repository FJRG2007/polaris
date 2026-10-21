/**
 * The shell's notices above a page - the disk warning, the refused-link note -
 * sat inside main's padding, and a screen that bleeds to the edges pulled itself
 * up over them with its negative margin: on Mail the warning covered the Write
 * button and the Inbox header, and the window, which does not scroll there, cut
 * the bottom of the screen off by the same height.
 *
 * The notices now take a strip of their own that gives main's padding back below
 * it, and publish their height; every screen that fills the window subtracts it.
 */

import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PAGE_BLEED, PAGE_FILL, PAGE_NOTICES } from "@polaris/ui";

const source = (path: string) => readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");

describe("the notices above a page", () => {
    it("are subtracted by every screen that fills the window", async () => {
        expect(PAGE_FILL).toContain("var(--notice-height)");
        expect(PAGE_BLEED).toContain("var(--notice-height)");
        const tokens = await source("../../../../packages/ui/src/styles/tokens.css");
        // Nothing published yet is no notice at all, not an unset variable that
        // throws the whole calc() away.
        expect(tokens).toMatch(/--notice-height: 0px;/);
    });

    it("sit in main's top padding and give it back below", async () => {
        const shell = await source("../../../../packages/ui/src/shell/app-shell.tsx");
        const main = shell.match(/<main[^>]*className="([^"]+)"/)?.[1].split(" ") ?? [];
        const notices = PAGE_NOTICES.split(" ");
        // main: p-3 sm:p-4 md:px-6 md:py-5 - the strip mirrors each step of it.
        const steps: [string, string, string][] = [
            ["p-3", "-mt-3", "mb-3"],
            ["sm:p-4", "sm:-mt-4", "sm:mb-4"],
            ["md:py-5", "md:-mt-5", "md:mb-5"]
        ];
        for (const [padding, up, down] of steps) {
            expect(main).toContain(padding);
            expect(notices).toEqual(expect.arrayContaining([up, down]));
        }
        expect(notices).toContain("empty:hidden");
    });

    it("hold the disk warning and the refused-link note", async () => {
        const chrome = await source("../../src/components/app-chrome.tsx");
        const strip = chrome.slice(
            chrome.indexOf("<PageNotices>"),
            chrome.indexOf("</PageNotices>")
        );
        expect(strip).toContain("<DeniedNotice />");
        expect(strip).toContain("<DiskAlertBanner />");
    });
});
