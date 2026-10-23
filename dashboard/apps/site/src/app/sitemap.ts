import type { MetadataRoute } from "next";
import { appIds } from "@/views/app-page";
import { SITE_LOCALES } from "@/data/builders";
import { asset, href, siteData, SITE_ORIGIN } from "@/lib/site";

export const dynamic = "force-static";

/**
 * Every page in both languages, each naming its other-language twin, so a
 * search engine finds every app's page and offers the reader's language.
 */
export default function sitemap(): MetadataRoute.Sitemap {
    const pages = [
        "",
        "marketplace/",
        "downloads/",
        "docs/",
        "docs/api/",
        ...siteData().docs.en.map((page) => `docs/${page.slug}/`),
        ...appIds("en").map((id) => `marketplace/${id}/`)
    ];
    const url = (locale: "en" | "es", page: string) => SITE_ORIGIN + asset(href(locale, page));
    return pages.flatMap((page) =>
        SITE_LOCALES.map((locale) => ({
            url: url(locale, page),
            alternates: { languages: { en: url("en", page), es: url("es", page) } }
        }))
    );
}
