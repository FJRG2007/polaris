/**
 * How much of every catalog each locale has translated: per app, per namespace,
 * counted in messages against the source locale.
 *
 *     npm run i18n:coverage              every locale, namespaces below 100% only
 *     npm run i18n:coverage -- de-DE     one locale
 *     npm run i18n:coverage -- --all     every namespace, finished ones too
 *
 * Reads the JSON catalogs straight from `apps/<app>/messages`, so it needs
 * nothing running. The same numbers are asserted in test/i18n/coverage.test.ts.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { catalogCoverage, isCompleteLocale, LOCALES, SOURCE_LOCALE } from "@polaris/core";

const APPS = join(dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const all = args.includes("--all");
const wanted = args.filter((arg) => !arg.startsWith("--"));
const locales = LOCALES.filter((locale) => locale !== SOURCE_LOCALE && (!wanted.length || wanted.includes(locale)));

function read(root, locale, namespace) {
    const file = join(root, locale, `${namespace}.json`);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
}

const percent = (done, total) => (total ? `${((done / total) * 100).toFixed(1)}%` : "-");

for (const locale of locales) {
    let done = 0;
    let total = 0;
    const rows = [];
    for (const app of readdirSync(APPS).sort()) {
        const root = join(APPS, app, "messages");
        if (!existsSync(join(root, SOURCE_LOCALE)) || !statSync(root).isDirectory()) continue;
        for (const file of readdirSync(join(root, SOURCE_LOCALE)).filter((name) => name.endsWith(".json")).sort()) {
            const namespace = file.slice(0, -".json".length);
            const counted = catalogCoverage(read(root, SOURCE_LOCALE, namespace), read(root, locale, namespace));
            done += counted.translated;
            total += counted.total;
            if (all || counted.translated < counted.total)
                rows.push({ app, namespace, translated: `${counted.translated}/${counted.total}`, coverage: percent(counted.translated, counted.total) });
        }
    }
    const marked = isCompleteLocale(locale) ? "complete" : "partial";
    console.log(`\n${locale} (${marked}): ${done}/${total} messages, ${percent(done, total)}`);
    if (rows.length) console.table(rows);
}
