/**
 * How much of every catalog each locale has translated - the numbers
 * `npm run i18n:coverage` prints, held to what the registry claims.
 *
 * A locale marked complete must be at 100% in every app and namespace. One not
 * marked complete must not be: once it is, the flag is what is out of date, and
 * the picker would go on calling a finished translation partial.
 */

import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
    catalogCoverage,
    isCompleteLocale,
    LOCALES,
    SOURCE_LOCALE,
    type Catalog
} from "@polaris/core";

const APPS = resolve(__dirname, "../../..");

function read(root: string, locale: string, namespace: string): Catalog | undefined {
    const file = join(root, locale, `${namespace}.json`);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Catalog) : undefined;
}

/** Every namespace's coverage in one locale, across the dashboard and every app. */
function coverage(locale: string) {
    const rows: { id: string; translated: number; total: number }[] = [];
    for (const app of readdirSync(APPS).sort()) {
        const root = join(APPS, app, "messages");
        if (!existsSync(join(root, SOURCE_LOCALE)) || !statSync(root).isDirectory()) continue;
        for (const file of readdirSync(join(root, SOURCE_LOCALE)).filter((name) => name.endsWith(".json"))) {
            const namespace = file.slice(0, -".json".length);
            const counted = catalogCoverage(
                read(root, SOURCE_LOCALE, namespace)!,
                read(root, locale, namespace)
            );
            rows.push({ id: `${app}/${namespace}`, ...counted });
        }
    }
    return rows;
}

describe("catalog coverage", () => {
    it.each(LOCALES.filter((locale) => locale !== SOURCE_LOCALE))("%s is what the registry says", (locale) => {
        const rows = coverage(locale);
        expect(rows.length).toBeGreaterThan(50);
        const short = rows.filter((row) => row.translated < row.total).map((row) => row.id);
        if (isCompleteLocale(locale)) expect(short).toEqual([]);
        else expect(short.length, `${locale} is fully translated: mark it complete`).toBeGreaterThan(0);
    });
});
