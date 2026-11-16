import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CODE_THEMES, codeThemeOf, DEFAULT_CODE_THEME } from "@/lib/polar/code-theme";
import { polarPreferencesPatchSchema } from "@/lib/polar/display";

const CSS = readFileSync(fileURLToPath(new URL("../../../src/app/globals.css", import.meta.url)), "utf8");
const TOKENS = ["comment", "keyword", "string", "number", "function", "type", "attr", "diff-add", "diff-remove"];

/** The declarations of the one rule whose selector is exactly `selector`. */
function rule(selector: string): string {
    const at = CSS.indexOf(`${selector} {`);
    expect(at, selector).toBeGreaterThanOrEqual(0);
    return CSS.slice(at, CSS.indexOf("}", at));
}

describe("Polar Code's themes", () => {
    it("reads anything stored that is not a theme as the default", () => {
        expect(codeThemeOf("nord")).toBe("nord");
        expect(codeThemeOf("matrix")).toBe(DEFAULT_CODE_THEME);
        expect(codeThemeOf(null)).toBe(DEFAULT_CODE_THEME);
        expect(codeThemeOf(42)).toBe(DEFAULT_CODE_THEME);
    });

    it("saves only a theme that exists", () => {
        expect(polarPreferencesPatchSchema.safeParse({ codeTheme: "gruvbox" }).success).toBe(true);
        expect(polarPreferencesPatchSchema.safeParse({ codeTheme: "<script>" }).success).toBe(false);
    });

    it("paints every token of every theme in dark, light and a light system", () => {
        for (const theme of CODE_THEMES) {
            if (theme === DEFAULT_CODE_THEME) {
                expect(CSS).not.toContain(`[data-code-theme="${theme}"]`);
                continue;
            }
            for (const selector of [
                `[data-code-theme="${theme}"]`,
                `:root.light [data-code-theme="${theme}"]`,
                `    :root.system [data-code-theme="${theme}"]`
            ]) {
                const body = rule(selector);
                for (const token of TOKENS) expect(body, `${selector} ${token}`).toContain(`--code-${token}:`);
            }
        }
    });
});
