/**
 * Every catalog, in every locale, checked where a mistake would otherwise reach
 * a reader.
 *
 * A key present in English and missing from a complete locale reads in English
 * on a screen promised in that language; a Spanish message that drops `{count}`
 * says the wrong thing; a brace out of place is a message that cannot be
 * formatted at all. All three are silent at build time,
 * so they fail here instead - for the dashboard's catalogs and for every
 * installable app's (`apps/<app>/messages`), which are found rather than listed.
 *
 * A locale the registry does not mark complete may leave out any namespace or
 * key - it reads the source's for those - but what it does carry is held to the
 * same rules: no key the source lacks, the same arguments and tags, valid ICU.
 *
 * The navigation's labels are checked against the app catalogue itself: a screen
 * added to `lib/apps.ts` needs its label here, and the English one must be the
 * catalogue's own word for word, which is what keeps an English reader's rail
 * exactly as it was.
 */

import * as nav from "@/lib/apps";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
    flattenCatalog,
    inspectMessage,
    isCompleteLocale,
    LOCALES,
    PRESENCE_DURATIONS,
    SOURCE_LOCALE,
    STATUS_DURATIONS,
    type Catalog,
    type Locale
} from "@polaris/core";
import { navLabels } from "./nav-labels";
import { webCatalogs } from "../../messages";

const APPS = resolve(__dirname, "../../..");

/** Every folder of catalogs: the dashboard's, and each app's that ships one. */
const ROOTS = readdirSync(APPS)
    .map((app) => join(APPS, app, "messages"))
    .filter((root) => existsSync(root) && statSync(root).isDirectory());

function namespacesIn(root: string, locale: string): string[] {
    const folder = join(root, locale);
    if (!existsSync(folder)) return [];
    return readdirSync(folder)
        .filter((file) => file.endsWith(".json"))
        .map((file) => file.slice(0, -".json".length))
        .sort();
}

function load(root: string, locale: string, namespace: string): Catalog {
    const file = join(root, locale, `${namespace}.json`);
    // A partial locale may not have started a namespace yet.
    if (!existsSync(file) && !isCompleteLocale(locale)) return {};
    return JSON.parse(readFileSync(file, "utf8")) as Catalog;
}

describe("the catalogs", () => {
    it("include the dashboard's, so this cannot pass by reading nothing", () => {
        expect(ROOTS.map((root) => root.replace(/\\/g, "/"))).toContain(
            join(APPS, "web", "messages").replace(/\\/g, "/")
        );
    });

    describe.each(ROOTS)("in %s", (root) => {
        const namespaces = namespacesIn(root, SOURCE_LOCALE);

        it("has a folder for every locale and nothing else", () => {
            const folders = readdirSync(root).filter((entry) =>
                statSync(join(root, entry)).isDirectory()
            );
            expect(folders.sort()).toEqual([...LOCALES].sort());
        });

        it.each(LOCALES)("%s has the source's namespaces (all of them when complete)", (locale) => {
            const own = namespacesIn(root, locale);
            if (isCompleteLocale(locale)) expect(own).toEqual(namespaces);
            else expect(own.filter((namespace) => !namespaces.includes(namespace))).toEqual([]);
        });

        // One import per file: a namespace written but never listed is one no
        // screen can reach, and one listed but never written fails the build.
        it.each(LOCALES)("%s lists every namespace it has, and only those", (locale) => {
            const index = readFileSync(join(root, locale, "index.ts"), "utf8");
            const imported = [...index.matchAll(/from\s+"\.\/([\w-]+)\.json"/g)]
                .map((match) => match[1])
                .sort();
            expect(imported).toEqual(namespacesIn(root, locale));
        });

        describe.each(namespaces)("namespace %s", (namespace) => {
            const source = flattenCatalog(load(root, SOURCE_LOCALE, namespace));

            it.each(LOCALES)("%s has the source's keys (exactly, when complete)", (locale) => {
                const keys = [...flattenCatalog(load(root, locale, namespace)).keys()].sort();
                if (isCompleteLocale(locale)) expect(keys).toEqual([...source.keys()].sort());
                else expect(keys.filter((key) => !source.has(key))).toEqual([]);
            });

            it.each(LOCALES)("%s is valid ICU, with the source's arguments and tags", (locale) => {
                const messages = flattenCatalog(load(root, locale, namespace));
                const problems: string[] = [];
                for (const [key, message] of messages) {
                    const inspected = inspectMessage(locale as Locale, message);
                    if (!inspected.ok) {
                        problems.push(`${namespace}.${key}: ${inspected.error}`);
                        continue;
                    }
                    const original = inspectMessage(SOURCE_LOCALE, source.get(key) ?? "");
                    if (!original.ok) continue;
                    if (inspected.args.join() !== original.args.join())
                        problems.push(
                            `${namespace}.${key}: arguments ${inspected.args} vs ${original.args}`
                        );
                    if (inspected.tags.join() !== original.tags.join())
                        problems.push(
                            `${namespace}.${key}: tags ${inspected.tags} vs ${original.tags}`
                        );
                    if (message.trim() === "") problems.push(`${namespace}.${key}: empty`);
                    // UTF-8 read back as Latin-1 somewhere on its way in: "pÃ¡gina" for "página".
                    if (/[ÂÃ][\u0080-¿]/.test(message))
                        problems.push(`${namespace}.${key}: mis-encoded text`);
                }
                expect(problems).toEqual([]);
            });
        });
    });
});

describe("the navigation catalog", () => {
    const english = webCatalogs.catalogs["en-US"].nav;

    it("has every label the app catalogue can draw, in English word for word", () => {
        const labels = english.labels as Readonly<Record<string, string>>;
        const wanted = [...navLabels()];
        expect(wanted.length).toBeGreaterThan(100);
        expect(wanted.filter((label) => labels[label] !== label)).toEqual([]);
    });

    it("carries no label the catalogue no longer has", () => {
        const wanted = navLabels();
        expect(Object.keys(english.labels).filter((label) => !wanted.has(label))).toEqual([]);
    });

    it("keys no label on a dot, which a key path would split", () => {
        expect(Object.keys(english.labels).filter((label) => label.includes("."))).toEqual([]);
    });

    it("describes every app exactly as the catalogue does", () => {
        const apps = english.apps as Readonly<
            Record<
                string,
                { description: string; guestDescription?: string; otherwiseDescription?: string }
            >
        >;
        for (const app of nav.POLARIS_APPS) {
            expect(apps[app.id]?.description, app.id).toBe(app.description);
            expect(apps[app.id]?.guestDescription, app.id).toBe(app.guest?.description);
            expect(apps[app.id]?.otherwiseDescription, app.id).toBe(
                app.guest?.otherwise?.description
            );
        }
        expect(Object.keys(apps).sort()).toEqual(nav.POLARIS_APPS.map((app) => app.id).sort());
    });

    it("has words for every length a status or a presence can be set for", () => {
        const t = webCatalogs.translator("en-US", "nav");
        for (const { minutes } of PRESENCE_DURATIONS) {
            if (minutes !== null)
                expect(t.has(`account.presenceFor.m${minutes}`), `presence ${minutes}`).toBe(true);
        }
        for (const { minutes } of STATUS_DURATIONS) {
            if (minutes !== null)
                expect(t.has(`account.status.clearsIn.m${minutes}`), `status ${minutes}`).toBe(
                    true
                );
        }
        // And the English is core's, word for word.
        for (const { minutes, label } of PRESENCE_DURATIONS) {
            expect(
                t(
                    (minutes === null
                        ? "account.presenceFor.untilChanged"
                        : `account.presenceFor.m${minutes}`) as never
                )
            ).toBe(label);
        }
        for (const { minutes, label } of STATUS_DURATIONS) {
            expect(
                t(
                    (minutes === null
                        ? "account.status.clearsIn.never"
                        : `account.status.clearsIn.m${minutes}`) as never
                )
            ).toBe(label);
        }
    });
});

describe("the catalogs in the browser", () => {
    /** Modules that hold every catalog, or reach the database. A client
     *  component that imported one would ship all of it to every page. */
    const SERVER_ONLY = [
        /messages["']$/,
        /\/messages\/index["']$/,
        /lib\/i18n\/(translate|request|locale-service)["']$/
    ];

    it("are never imported by a client component", () => {
        const src = resolve(__dirname, "../../src");
        const offenders: string[] = [];
        const walk = (directory: string) => {
            for (const entry of readdirSync(directory)) {
                const full = join(directory, entry);
                if (statSync(full).isDirectory()) walk(full);
                else if (/\.tsx?$/.test(entry)) {
                    const text = readFileSync(full, "utf8");
                    if (!/^\s*["']use client["']/m.test(text)) continue;
                    for (const match of text.matchAll(
                        /^import\s+(?!type\b)[^;]*?from\s+(["'][^"']+["'])/gm
                    )) {
                        if (SERVER_ONLY.some((pattern) => pattern.test(match[1] ?? "")))
                            offenders.push(`${full}: ${match[1]}`);
                    }
                }
            }
        };
        walk(src);
        expect(offenders).toEqual([]);
    });
});
