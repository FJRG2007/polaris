/**
 * A translated label takes about the room its English one does.
 *
 * Buttons, tabs, menu items, column headers and badges are sized by their words:
 * a Spanish label a third longer than the English one wraps, overflows or
 * stretches the row that fit in English. So a short label - no sentence
 * punctuation, no argument, no tag - may be longer than its source only by a
 * small margin (`budget`). Prose that wraps is not held to it.
 *
 * `scripts/i18n-long.json` lists the labels that were over the budget when this
 * rule came in. It only shrinks: a new label over the budget fails, and so does
 * an entry that is no longer over it, so shortening one means removing its line.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { flattenCatalog, LOCALES, SOURCE_LOCALE, type Catalog } from "@polaris/core";

const APPS = resolve(__dirname, "../../..");
const LONG = resolve(__dirname, "../../scripts/i18n-long.json");

/** The longest source text that still counts as a label rather than prose. */
const LABEL_MAX = 32;

/** How long a translation of a label of `length` characters may be. */
export function budget(length: number): number {
    return length + Math.max(3, Math.ceil(length * 0.25));
}

/** A label: short, and not a sentence, a placeholder or a marked-up message. */
function isLabel(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.length <= LABEL_MAX && !/[{<]/.test(trimmed) && !/[.!?:]$/.test(trimmed);
}

function load(root: string, locale: string, namespace: string): Map<string, string> {
    return flattenCatalog(JSON.parse(readFileSync(join(root, locale, `${namespace}.json`), "utf8")) as Catalog);
}

/** `<app>/<namespace>:<key> (<locale>)` for every label over its budget. */
function overBudget(): string[] {
    const found: string[] = [];
    for (const app of readdirSync(APPS).sort()) {
        const root = join(APPS, app, "messages");
        if (!existsSync(root) || !statSync(root).isDirectory()) continue;
        const namespaces = readdirSync(join(root, SOURCE_LOCALE))
            .filter((file) => file.endsWith(".json"))
            .map((file) => file.slice(0, -".json".length))
            .sort();
        for (const namespace of namespaces) {
            const source = load(root, SOURCE_LOCALE, namespace);
            for (const locale of LOCALES) {
                if (locale === SOURCE_LOCALE || !existsSync(join(root, locale, `${namespace}.json`))) continue;
                const translated = load(root, locale, namespace);
                for (const [key, text] of source) {
                    const other = translated.get(key);
                    if (other === undefined || !isLabel(text)) continue;
                    if (other.trim().length > budget(text.trim().length)) {
                        found.push(`${app}/${namespace}:${key} (${locale})`);
                    }
                }
            }
        }
    }
    return found.sort();
}

describe("translated labels", () => {
    const found = overBudget();
    const allowed = (JSON.parse(readFileSync(LONG, "utf8")) as string[]).slice().sort();

    it("fit about the room of the English, or are listed as the old ones still to shorten", () => {
        expect(found.filter((entry) => !allowed.includes(entry))).toEqual([]);
    });

    it("leave the list once they are short enough", () => {
        expect(allowed.filter((entry) => !found.includes(entry))).toEqual([]);
    });

    it("budget a margin even for the shortest word", () => {
        expect(budget(2)).toBe(5);
        expect(budget(20)).toBe(25);
    });
});
