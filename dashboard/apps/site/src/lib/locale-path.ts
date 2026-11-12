import type { SiteLocale } from "@/data/builders";

/** The same page in another locale. English pages at the root move under the locale too. */
export function pathInLocale(
    path: string,
    locale: SiteLocale,
    locales: readonly SiteLocale[]
): string {
    const rest = path.replace(/^\/+/, "").split("/");
    const tail = (locales as readonly string[]).includes(rest[0] ?? "")
        ? rest.slice(1)
        : rest;
    return `/${[locale, ...tail].join("/")}`.replace(/\/*$/, "/");
}
