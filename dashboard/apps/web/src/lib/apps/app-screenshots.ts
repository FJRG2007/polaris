/**
 * The screenshots an app's Marketplace page shows.
 *
 * Only Polaris's own apps have them, and only the ones the README's demo media
 * already captured: each shot is the same file as `docs/assets/media`, copied
 * under `public/marketplace` because the dashboard image is built from
 * `dashboard/` and cannot reach the repository's docs. An app with no entry
 * here shows no screenshots - none is ever drawn or mocked up for it.
 */

/** Which captures belong to which catalog app, in the order they are shown. */
const SHOTS: Readonly<Record<string, readonly string[]>> = {
    calendar: ["calendar", "calendar-time"],
    "game-servers": ["games", "game-players", "game-console", "game-inventory", "game-events"],
    home: ["places"]
};

export interface AppScreenshot {
    /** Per theme, the desktop and the phone capture. */
    readonly dark: { readonly desktop: string; readonly mobile: string };
    readonly light: { readonly desktop: string; readonly mobile: string };
}

/** The language a capture was taken in: Spanish for a Spanish reader, English otherwise. */
export function screenshotLanguage(locale: string): "en" | "es" {
    return locale.toLowerCase().startsWith("es") ? "es" : "en";
}

export function appScreenshots(catalogId: string, locale: string): AppScreenshot[] {
    const language = screenshotLanguage(locale);
    const file = (slug: string, theme: string, form: string) =>
        `/marketplace/${slug}-${theme}-${language}-${form}.webp`;
    return (SHOTS[catalogId] ?? []).map((slug) => ({
        dark: { desktop: file(slug, "dark", "desktop"), mobile: file(slug, "dark", "mobile") },
        light: { desktop: file(slug, "light", "desktop"), mobile: file(slug, "light", "mobile") }
    }));
}

/**
 * The one capture a store card shows: the app's first screenshot, or null for an
 * app that has none, which the card answers with its designed placeholder rather
 * than with a picture of something the app is not.
 */
export function appPreview(catalogId: string, locale: string): AppScreenshot | null {
    return appScreenshots(catalogId, locale)[0] ?? null;
}

/** Whether a real capture of the app exists at all. */
export function hasScreenshots(catalogId: string): boolean {
    return (SHOTS[catalogId]?.length ?? 0) > 0;
}
