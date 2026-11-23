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
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import defaultTheme from "tailwindcss/defaultTheme";
import preset from "../../../../packages/ui/src/tailwind-preset";

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
});
