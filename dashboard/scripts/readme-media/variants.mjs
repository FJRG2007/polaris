/**
 * Every picture a scene is taken as, and the file each one is saved to.
 *
 * Shared by the capture, which writes the files, and the test, which checks the
 * README points at files that exist - so the two cannot disagree about a name.
 */

/** The frames, fixed so the README layout never shifts between runs. */
export const VIEWPORTS = {
    desktop: { width: 1440, height: 900 },
    mobile: { width: 390, height: 844 }
};
export const THEMES = ["dark", "light"];
export const LOCALES = { en: "en-US", es: "es-ES" };

/** The moment every scene is pictured at, 11:24 on a Wednesday in Madrid. The
 *  capture freezes the page's clock here, and the fixtures count from it. */
export const MOMENT = Date.UTC(2026, 2, 18, 10, 24, 0);

/** Where the pictures live, from the repository root. */
export const MEDIA_DIR = "docs/assets/media";

/** The file one variant of one scene is saved as: `chat-dark-en-desktop.webp`. */
export function mediaName(id, theme, language, viewport) {
    return `${id}-${theme}-${language}-${viewport}.webp`;
}

/** Every variant, in the order the capture takes them. */
export function variants() {
    const all = [];
    for (const [language, locale] of Object.entries(LOCALES)) {
        for (const theme of THEMES) {
            for (const viewport of Object.keys(VIEWPORTS))
                all.push({ language, locale, theme, viewport });
        }
    }
    return all;
}
