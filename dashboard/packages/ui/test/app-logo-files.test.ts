import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { APP_LOGO_IDS, appLogoFileText } from "../src/shell/app-logo-file";

const folder = join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "app-logos");
const REGENERATE =
    "run `npm run logos -w @polaris/ui` (scripts/app-logo-files.mjs) and commit the result";

/**
 * The committed logo files are `LOGOS` written out, nothing else: every
 * surface outside the dashboard reads them, so a logo redrawn in the component
 * and not here would show two different logos for one app.
 */
describe("app logo files", () => {
    it("has exactly one file per app logo", () => {
        const files = readdirSync(folder).sort();
        const expected = APP_LOGO_IDS.map((id) => `${id}.svg`).sort();
        expect(files, `The logo files are out of date: ${REGENERATE}.`).toEqual(expected);
    });

    it.each(APP_LOGO_IDS)("%s.svg is what the component draws", (id) => {
        const text = appLogoFileText(id);
        const committed = readFileSync(join(folder, `${id}.svg`), "utf8");
        expect(committed, `${id}.svg is out of date: ${REGENERATE}.`).toBe(text);
    });

    it.each(APP_LOGO_IDS)("%s.svg stands alone on the shared canvas", (id) => {
        const text = appLogoFileText(id)!;
        expect(text.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"')).toBe(
            true
        );
        expect(text.endsWith("</svg>\n")).toBe(true);
        expect(text.endsWith("\n\n")).toBe(false);
        // Nothing a page adds: no class, style, data or aria attributes.
        expect(text).not.toMatch(/\s(class|style|data-[\w-]+|aria-[\w-]+|focusable)=/);
        // Every id is the app's own, and every reference resolves inside the file.
        const ids = [...text.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
        expect(ids.length).toBeGreaterThan(0);
        for (const ref of ids) expect(ref.startsWith(`${id}-`)).toBe(true);
        for (const [, ref] of text.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref);
    });

    it("draws nothing for an app without a logo", () => {
        expect(appLogoFileText("not-an-app")).toBeNull();
    });
});
