/**
 * In the desktop app the window buttons take about 138 px of the top bar, so a
 * bar that picked its labels and its search field by window width (`sm:`,
 * `lg:`) was fuller in the app than a browser of the same width, and clipped
 * sooner (BUG-0025). The bar's own items pick by the room the bar has: `tb-*`,
 * a container query on the frame around it, at the same pixel widths as the
 * screen breakpoints, so in a browser nothing changes.
 */

import postcss from "postcss";
import tailwind from "tailwindcss";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import defaultTheme from "tailwindcss/defaultTheme";
import preset from "../../../../packages/ui/src/tailwind-preset";
import { TITLEBAR_SCREENS, titlebarUnder } from "../../../../packages/ui/src/shell/titlebar-screens";

const DASHBOARD = resolve(__dirname, "../../../..");
const read = (path: string) => readFileSync(join(DASHBOARD, path), "utf8").replace(/\s+/g, " ");

async function utilities(markup: string): Promise<string> {
    const result = await postcss([
        tailwind({
            presets: [preset],
            content: [{ raw: markup, extension: "html" }],
            corePlugins: { preflight: false }
        })
    ]).process("@tailwind utilities;", { from: undefined });
    return result.css.replace(/\s+/g, " ");
}

describe("the top bar's widths", () => {
    it("are the screen breakpoints, in px, measured on the bar's frame", async () => {
        const css = await utilities(`<b class="tb-sm:inline tb-md:inline tb-lg:block tb-xl:inline tb-2xl:inline sm:inline">`);
        const screens = defaultTheme.screens as Record<string, string>;
        expect(screens).toMatchObject({ sm: "640px", lg: "1024px", xl: "1280px" });
        for (const [name, width] of Object.entries(screens)) {
            expect(css).toContain(`@container titlebar (min-width: ${width})`);
            expect(css).toContain(`.tb-${name}\\:`);
        }
        expect(css).toContain("@media (min-width: 640px) { .sm\\:inline { display: inline } }");
        expect(css).toContain("@container titlebar (min-width: 640px) { .tb-sm\\:inline { display: inline } }");
    });

    it("are what the bar's own items switch on", () => {
        const palette = read("apps/web/src/components/command-palette.tsx");
        expect(palette).toContain("tb-sm:size-9 tb-sm:border tb-sm:border-border tb-sm:bg-surface tb-lg:w-full");
        expect(palette).toContain('<span className="hidden flex-1 truncate text-start text-sm tb-lg:block">');
        const polar = read("apps/web/src/components/polar/polar-panel.tsx");
        expect(polar).toContain('<span className="hidden tb-lg:inline">{t("toggle.label")}</span>');
        expect(polar).toContain("text-foreground-subtle tb-xl:inline");
        const scope = read("apps/web/src/components/scope-switcher.tsx");
        expect(scope).toContain("hidden truncate text-sm tb-sm:inline");
        expect(scope).not.toMatch(/(?<![\w-])sm:(inline|block|px-2)\b/);
        const chrome = read("apps/web/src/components/app-chrome.tsx");
        expect(chrome).toContain('<PolarisMark nameClassName="hidden tb-sm:inline" />');
    });

    it("keep the mail composer's full posture below the window buttons", () => {
        const composer = read("apps/web/src/app/(app)/mail/composer.tsx");
        expect(composer).toContain(
            'const shellClass = clearWindowControls( posture === "full" ? "inset-0 md:inset-10 md:top-[calc(2.5rem+var(--window-controls-height))]'
        );
    });

    it("tell the page outside the bar which screens the bar is narrower than", async () => {
        const screens = defaultTheme.screens as Record<string, string>;
        expect(Object.fromEntries(Object.entries(TITLEBAR_SCREENS).map(([name, px]) => [name, `${px}px`]))).toEqual(screens);
        expect(titlebarUnder(2000)).toBe("");
        expect(titlebarUnder(1024)).toBe("xl 2xl");
        expect(titlebarUnder(767.5)).toBe("md lg xl 2xl");
        expect(titlebarUnder(300)).toBe("sm md lg xl 2xl");
        const css = await utilities(`<b class="md:hidden under-tb-md:flex">`);
        expect(css).toContain(':root[data-titlebar-under~="md"] .under-tb-md\\:flex { display: flex }');
    });
});

/**
 * A page that portals a control into the bar (`HeaderPortal`) and keeps a copy
 * of it in the page for when the bar has no room: the bar's copy switches on
 * the bar's own width, and the page copy at the same point through
 * `under-tb-*`. With `md:` on both, the desktop app's bar clipped the bar copy
 * while the page copy stayed hidden (BUG-0025).
 */
describe("controls portalled into the top bar", () => {
    const SCREEN = /(?<![\w-])(sm|md|lg|xl|2xl):[\w[\]().%/-]+/g;
    const walk = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
            entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name.endsWith(".tsx") ? [join(dir, entry.name)] : []
        );
    const users = walk(join(DASHBOARD, "apps/web/src"))
        .map((path) => ({ path, source: readFileSync(path, "utf8") }))
        .filter(({ source }) => source.includes("<HeaderPortal>"));

    it("are found", () => {
        expect(users.length).toBeGreaterThanOrEqual(3);
    });

    for (const { path, source } of users) {
        const name = path.slice(DASHBOARD.length + 1).replace(/\\/g, "/");
        it(`${name} switches by the bar's width`, () => {
            const blocks = [...source.matchAll(/<HeaderPortal>([\s\S]*?)<\/HeaderPortal>/g)].map((match) => match[1]!);
            expect(blocks.length).toBeGreaterThan(0);
            // The portal's markup and every element it places by name.
            const placed = blocks.flatMap((block) => [...block.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!));
            const parts = [...blocks];
            for (const id of placed) {
                const definition = source.match(new RegExp(`const ${id} =([\\s\\S]*?)\\n\\s*(?:const|return|function)\\b`));
                if (definition) parts.push(definition[1]!);
            }
            for (const part of parts) {
                for (const [, classes] of part.matchAll(/className="([^"]*)"/g)) {
                    expect(classes!.match(SCREEN) ?? [], `${name}: "${classes}"`).toEqual([]);
                }
            }
            // The page copy, hidden at the width the bar's copy shows at, comes
            // back while the bar is narrower than it.
            const shownAt = new Set(blocks.flatMap((block) => [...block.matchAll(/(?<![\w-])tb-(sm|md|lg|xl|2xl):/g)].map((match) => match[1]!)));
            expect(shownAt.size).toBeGreaterThan(0);
            let copies = 0;
            for (const [, classes] of source.matchAll(/className="([^"]*)"/g)) {
                for (const [, screen] of classes!.matchAll(/(?<![\w-])(sm|md|lg|xl|2xl):hidden\b/g)) {
                    if (!shownAt.has(screen!)) continue;
                    copies += 1;
                    expect(classes, name).toMatch(new RegExp(`(?<![\\w-])under-tb-${screen}:(flex|block|inline|inline-flex|grid)\\b`));
                }
            }
            expect(copies, name).toBeGreaterThan(0);
        });
    }
});
