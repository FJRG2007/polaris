/**
 * The account's text size in the pages, both ways: the Polaris window reports
 * it, and the app's own windows take it. Kept apart from `@/shared/text-size`
 * so a preload does not bundle the dashboard's display schema: the main process
 * validates what is reported and only ever sends back a size it accepted.
 */

/** The dashboard's text size property on its root element. */
const PROPERTY = "--app-text-size";

/** In the Polaris window: report the account's size on load and whenever the
 *  Accessibility page changes it, which it does on the root's style. */
export function reportTextSize(report: (raw: string) => void): void {
    // A preload loaded outside a page (a test) has nothing to watch.
    if (typeof window === "undefined") return;
    let last = "";
    const read = () => {
        const raw = document.documentElement.style.getPropertyValue(PROPERTY).trim();
        if (!raw || raw === last) return;
        last = raw;
        report(raw);
    };
    window.addEventListener("DOMContentLoaded", () => {
        read();
        new MutationObserver(read).observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    });
}

/** In one of the app's own windows: its root takes the size, which every rem follows. */
export function applyTextSize(size: number): void {
    if (typeof document === "undefined") return;
    const apply = () => document.documentElement.style.setProperty("font-size", `${size}px`);
    if (document.documentElement) apply();
    else window.addEventListener("DOMContentLoaded", apply, { once: true });
}
