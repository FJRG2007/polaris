/**
 * What every page reads: the generated data, the site's own words, and the
 * paths it links with. Read at build time only; the export holds the result.
 */

import { join } from "node:path";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import { readFileSync } from "node:fs";
import type { SiteData, SiteLocale } from "@/data/builders";

export type Words = typeof en;

const WORDS: Readonly<Record<SiteLocale, Words>> = { en, es };

export function words(locale: SiteLocale): Words {
    return WORDS[locale];
}

let cached: SiteData | null = null;

/** The data `npm run generate` wrote; the build fails loudly without it. */
export function siteData(): SiteData {
    cached ??= JSON.parse(
        readFileSync(join(process.cwd(), "generated", "site-data.json"), "utf8")
    ) as SiteData;
    return cached;
}

/** A file under `public/`, with the base path Pages serves the site under. */
export function asset(path: string): string {
    return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/${path.replace(/^\/+/, "")}`;
}

/** A page's path in a locale. English lives at the root as well as under /en. */
export function href(locale: SiteLocale, page = ""): string {
    return `/${locale}/${page}`.replace(/\/+$/, "/");
}

/** Whether a locale segment is one the site is built in. */
export function isLocale(value: string): value is SiteLocale {
    return value === "en" || value === "es";
}
