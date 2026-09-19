// @vitest-environment jsdom

/**
 * Turning the wheel over a file being read scrolls it.
 *
 * Opening a .txt sent in a chat showed the text with a working scrollbar, and
 * the wheel over the text did nothing. The text sat in a `pre` that could scroll
 * both ways and kept its scrolling to itself (`overscroll-contain`). A `pre`
 * never has a height of its own - the box around it is what scrolls down - so
 * it had no vertical scroll to spend the wheel on, and containment stopped the
 * wheel from reaching the box that did. Measured in Chrome: an `overflow: auto`
 * element with `overscroll-behavior: contain` swallows a vertical wheel even
 * when nothing in it overflows at all.
 *
 * So a `pre` with no height of its own scrolls sideways only, and never
 * contains: it has a long line to reach and nothing else.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { PlainTextEditor } from "@/app/(app)/drive/viewer/text-editor";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/app/(app)/drive/viewer/editor-actions", () => ({ EditorActions: () => null }));

const TARGET = { path: "notes.txt", name: "notes.txt", size: "40" };

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe("a plain-text file being read", () => {
    it("scrolls in the box around the text, and the text only scrolls sideways", async () => {
        vi.stubGlobal("fetch", async () => new Response("first line\nsecond line\n"));
        render(<PlainTextEditor src="/bytes/notes.txt" target={TARGET} readOnly />);

        const text = await waitFor(() => screen.getByText(/first line/));
        expect(text.tagName).toBe("PRE");
        expect(text.className).toContain("overflow-x-auto");
        expect(text.className).not.toMatch(/\boverflow-auto\b/);
        expect(text.className).not.toContain("overscroll-");

        const box = text.parentElement!;
        expect(box.className).toContain("overflow-auto");
    });
});

describe("every pre in the app", () => {
    const root = join(__dirname, "..", "..", "src");

    function sources(dir: string): string[] {
        const found: string[] = [];
        for (const entry of readdirSync(dir)) {
            const path = join(dir, entry);
            if (statSync(path).isDirectory()) found.push(...sources(path));
            else if (/\.tsx$/.test(entry)) found.push(path);
        }
        return found;
    }

    it("leaves the wheel to whatever scrolls around it, unless it has a height of its own", () => {
        const trapped: string[] = [];
        for (const path of sources(root)) {
            const source = readFileSync(path, "utf8");
            // `[&_pre]:` is a class list written for the pre inside, so it counts.
            for (const match of source.matchAll(/<pre\b[^>]*className="([^"]*)"|"([^"]*\[&_pre\]:[^"]*)"/g)) {
                const classes = match[1] ?? match[2] ?? "";
                // One given a height of its own is a real scroller, and may
                // keep its scrolling. One without is only ever as tall as its
                // text, so it never scrolls down - and containing it only
                // swallows the wheel.
                const ownHeight = /(?:^|\s)(?:max-h-|h-|flex-1)/.test(classes);
                if (/overscroll-/.test(classes) && !ownHeight) trapped.push(`${path.split(/[/\\]/).slice(-2).join("/")}: ${classes}`);
            }
        }
        expect(trapped).toEqual([]);
    });
});
