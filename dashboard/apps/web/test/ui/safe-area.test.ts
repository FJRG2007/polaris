/**
 * Every phone shape - a notch, a punch-hole, a Dynamic Island, a phone held
 * sideways - is handled by one model: the viewport is `viewport-fit=cover`, the
 * insets are read once into the `--safe-*` tokens, and the chrome pads with
 * those. A second reading of `env(safe-area-inset-*)` somewhere else is how two
 * screens end up disagreeing about where the edge is.
 */

import postcss from "postcss";
import tailwind from "tailwindcss";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import preset from "../../../../packages/ui/src/tailwind-preset";

const DASHBOARD = resolve(__dirname, "../../../..");
const TOKENS = join(DASHBOARD, "packages/ui/src/styles/tokens.css");

function walk(directory: string, found: string[] = []): string[] {
    for (const name of readdirSync(directory)) {
        const path = join(directory, name);
        if (statSync(path).isDirectory()) walk(path, found);
        else if (/\.(tsx?|css)$/.test(name)) found.push(path);
    }
    return found;
}

describe("safe area", () => {
    it("lays the page out under the notch, so the browser reports the insets", () => {
        // Read from the source: the layout itself pulls in the session and the database.
        const layout = readFileSync(join(DASHBOARD, "apps/web/src/app/layout.tsx"), "utf8").replace(/\s+/g, " ");
        expect(layout).toContain('export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };');
    });

    it("reads the insets in one place", () => {
        const sources = [join(DASHBOARD, "apps/web/src"), join(DASHBOARD, "packages/ui/src")].flatMap((dir) => walk(dir));
        const readers = sources.filter((path) => /env\(safe-area-inset-[a-z]/.test(readFileSync(path, "utf8")));
        expect(readers.map((path) => path.slice(DASHBOARD.length + 1).replace(/\\/g, "/"))).toEqual([
            "packages/ui/src/styles/tokens.css"
        ]);
    });

    it("counts the screen edges in what a full-height screen subtracts", () => {
        const css = readFileSync(TOKENS, "utf8").replace(/\s+/g, " ");
        expect(css).toMatch(/--notice-height: calc\([^;]*var\(--header-safe-top\)[^;]*var\(--safe-bottom\)/);
        expect(css).toMatch(/\[dir="rtl"\] \{ --safe-start: var\(--safe-right\); --safe-end: var\(--safe-left\); \}/);
    });

    it("pads a screen outside the shell by its spacing plus the inset on each side", async () => {
        const result = await postcss([
            tailwind({
                presets: [preset],
                content: [{ raw: `<main class="safe-p-4 safe-px-6 sm:safe-py-16 safe-p-0">`, extension: "html" }],
                corePlugins: { preflight: false }
            })
        ]).process("@tailwind utilities;", { from: undefined });
        const css = result.css.replace(/\s+/g, " ");
        expect(css).toContain(
            ".safe-p-4 { padding-top: calc(1rem + var(--safe-top)); padding-right: calc(1rem + var(--safe-right)); padding-bottom: calc(1rem + var(--safe-bottom)); padding-left: calc(1rem + var(--safe-left)) }"
        );
        expect(css).toContain(".safe-px-6 { padding-right: calc(1.5rem + var(--safe-right)); padding-left: calc(1.5rem + var(--safe-left)) }");
        expect(css).toContain("padding-top: calc(0px + var(--safe-top))");
        expect(css).toMatch(/@media \(min-width: 640px\) \{ \.sm\\:safe-py-16 \{ padding-top: calc\(4rem \+ var\(--safe-top\)\)/);
    });
});
