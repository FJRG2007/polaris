/**
 * Copy that talks about the Polaris the reader is in is worded for it.
 *
 * The same screens are drawn in a browser tab, in the desktop app and in the
 * dashboard installed as an app, and "this browser" or "another tab" read wrong
 * in two of them - the desktop app has no tabs and asks the system, not a
 * browser, for notices. Every message is formatted with `{surface}` and `{clientKind}`
 * (packages/core/src/client-surface.ts), so a sentence about the reader's own
 * client chooses its words there:
 *
 *     "{surface, select, app {This app cannot...} other {This browser cannot...}}"
 *
 * Held here for every catalog rather than trusted to each screen, because the
 * sentence that forgets is the one written next. A sentence about browsers in
 * general - visitors' browsers, the browser extension, which browser to install
 * it into - is not about the reader's client and is not matched: what is matched
 * is the reader's own browser or tab, by the words that point at it.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { flattenCatalog, LOCALES, type Catalog } from "@polaris/core";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const APPS = resolve(__dirname, "../../..");

const POINTS_AT_THE_READERS_CLIENT: readonly RegExp[] = [
    // "the tab" alone is as often one of a screen's own tabs, so only the ways a
    // sentence points at the browser's: closing it, leaving it, being outside it.
    /\b(this browser|this tab|another tab|(close|closes|leave|outside) the tab|tab icon|browser notifications)\b/i,
    /(este navegador|esta pestaña|otra pestaña|(cierras|cerrar|cierra|fuera de) la pestaña)/i
];

const WORDED_BY_CLIENT = /\{(surface|clientKind), select,/;

/**
 * Where the reader's browser is meant whatever they are reading it in, and why.
 */
const ALLOWED = new Set<string>([
    // The extension download page names the browser the reader installs it into.
    "web/account:downloads.steps.noBuild",
    // Polar's sites are opened in the browser the extension is in, never in the app.
    "web/polar:web.browserMissing"
]);

function offending(): string[] {
    const found: string[] = [];
    for (const app of readdirSync(APPS).sort()) {
        const root = join(APPS, app, "messages");
        if (!existsSync(root) || !statSync(root).isDirectory()) continue;
        for (const locale of LOCALES) {
            const dir = join(root, locale);
            if (!existsSync(dir)) continue;
            for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
                const namespace = file.slice(0, -".json".length);
                const catalog = JSON.parse(readFileSync(join(dir, file), "utf8")) as Catalog;
                for (const [key, text] of flattenCatalog(catalog)) {
                    const id = `${app}/${namespace}:${key}`;
                    if (ALLOWED.has(id) || WORDED_BY_CLIENT.test(text)) continue;
                    if (POINTS_AT_THE_READERS_CLIENT.some((pattern) => pattern.test(text))) {
                        found.push(`${id} (${locale})`);
                    }
                }
            }
        }
    }
    return found;
}

describe("copy about the reader's own browser or tab", () => {
    it("is worded for the app as well, everywhere", () => {
        expect(offending()).toEqual([]);
    });

    it("is caught in the shapes it takes", () => {
        const caught = [
            "This browser cannot record video.",
            "while you are on another tab",
            "Tab icon"
        ];
        for (const sample of caught) {
            expect(POINTS_AT_THE_READERS_CLIENT.some((pattern) => pattern.test(sample))).toBe(true);
        }
        const general = ["Visitors' browsers solve a short calculation.", "Browser extension"];
        for (const sample of general) {
            expect(POINTS_AT_THE_READERS_CLIENT.some((pattern) => pattern.test(sample))).toBe(
                false
            );
        }
    });
});
