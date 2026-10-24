/**
 * What every page reads: the generated data, the site's own words, and the
 * paths it links with. Read at build time only; the export holds the result.
 */

import { join } from "node:path";
import en from "@/messages/en.json";
import es from "@/messages/es.json";
import { readFileSync } from "node:fs";
import type { Metadata, Viewport } from "next";
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

/** Where the site is published, for the absolute addresses a shared link needs. */
export const SITE_ORIGIN = process.env.SITE_ORIGIN ?? "https://fjrg2007.github.io";

/** The browser's colour around the page: the dashboard's dark background. */
export const SITE_VIEWPORT: Viewport = { themeColor: "#0b0c0e" };

/**
 * A page's title, description, icons and link preview in one locale, so a
 * link pasted into a chat shows Polaris's mark, the page's own title and a
 * real screenshot of the product.
 */
export function pageMetadata(
    locale: SiteLocale,
    {
        title,
        description,
        page = "",
        picture
    }: {
        title?: string;
        description?: string;
        page?: string;
        /** The page's own preview picture under `media/`; the README's lead capture otherwise. */
        picture?: { file: string; alt: string };
    }
): Metadata {
    const t = words(locale).meta;
    const full = title ? `${title} - Polaris` : "Polaris";
    const summary = description ?? t.description;
    const lead = siteData().locales[locale].showcase[0]?.items[0];
    const image = picture
        ? { url: asset(`media/${picture.file}`), alt: picture.alt }
        : lead
          ? { url: asset(`media/${lead.dark}`), alt: t.ogAlt }
          : undefined;
    const url = asset(href(locale, page));
    return {
        metadataBase: new URL(SITE_ORIGIN),
        title: full,
        description: summary,
        alternates: {
            canonical: url,
            languages: { en: asset(href("en", page)), es: asset(href("es", page)) }
        },
        icons: {
            icon: [
                { url: asset("favicon.ico"), sizes: "any" },
                { url: asset("icon.svg"), type: "image/svg+xml" }
            ],
            apple: asset("apple-touch-icon.png")
        },
        manifest: asset("manifest.webmanifest"),
        openGraph: {
            type: "website",
            siteName: "Polaris",
            title: full,
            description: summary,
            url,
            locale: locale === "es" ? "es_ES" : "en_US",
            images: image ? [image] : undefined
        },
        twitter: {
            card: "summary_large_image",
            title: full,
            description: summary,
            images: image ? [image] : undefined
        }
    };
}
