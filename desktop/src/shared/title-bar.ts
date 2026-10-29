/**
 * The colours of the window buttons drawn over a Polaris page.
 *
 * On Windows and Linux the minimize, maximize and close buttons sit on the
 * page's header (`titleBar` in windows.ts), so they have to be painted like it:
 * a dark page under light-theme buttons is a white block in the corner. Polaris
 * has its own theme setting, independent of the system's, so the colours are
 * read off the page itself - whatever is drawn under the buttons - and read
 * again whenever the theme changes.
 */

import { z } from "zod";

const HEX = /^#[0-9a-f]{6}$/;

export const titleBarColorsSchema = z.object({
    background: z.string().regex(HEX),
    symbol: z.string().regex(HEX)
});

export type TitleBarColors = z.infer<typeof titleBarColorsSchema>;

/** How tall the window buttons are at 100%: the dashboard's header, which they
 *  sit in. */
export const TITLE_BAR_HEIGHT = 48;

/** The buttons' height at a page zoom, so they keep lining up with the header
 *  the zoom scaled. */
export function overlayHeight(zoom: number): number {
    const factor = Number.isFinite(zoom) && zoom > 0 ? Math.min(Math.max(zoom, 0.25), 5) : 1;
    return Math.round(TITLE_BAR_HEIGHT * factor);
}

/** The buttons' colours before a page has said what is under them, following
 *  the system's theme. */
export function defaultTitleBarColors(dark: boolean): TitleBarColors {
    return dark ? { background: "#101114", symbol: "#e6e7ea" } : { background: "#ffffff", symbol: "#1c1d21" };
}

/**
 * What a page that is not Polaris - a provider's sign-in during a round trip -
 * is given in the window: it is moved down below the buttons, and the band they
 * sit in is filled and drags the window, since that page has no header of ours.
 */
export function foreignPageCss(background: string): string {
    if (!HEX.test(background)) throw new Error("not a hex colour");
    return [
        "html { padding-top: env(titlebar-area-height, 0px) !important; }",
        "html::before { content: \"\"; position: fixed; inset: 0 0 auto 0; z-index: 2147483647;",
        `  height: env(titlebar-area-height, 0px); background: ${background}; app-region: drag; }`
    ].join("\n");
}

/** `rgb(16, 17, 20)` / `rgba(...)` as `#101114`, or null when it is see-through
 *  or not a colour at all. */
export function hexOf(css: string): string | null {
    const match = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(css.trim());
    if (!match) return null;
    const alpha = match[4];
    if (alpha !== undefined && (alpha.endsWith("%") ? parseFloat(alpha) / 100 : Number(alpha)) < 1) return null;
    const channels = [match[1], match[2], match[3]].map((value) => Math.min(255, Number(value)));
    return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

/** Light symbols on a dark ground, dark ones on a light ground. */
export function symbolFor(background: string): string {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(background.slice(at, at + 2), 16) / 255) as [number, number, number];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 0.5 ? "#e6e7ea" : "#1c1d21";
}

/** The first opaque background at a point, walking up from what is drawn there. */
function backgroundAt(x: number, y: number): string | null {
    for (let node = document.elementFromPoint(x, y); node; node = node.parentElement) {
        const hex = hexOf(getComputedStyle(node).backgroundColor);
        if (hex) return hex;
    }
    return null;
}

/**
 * Report the colours under the buttons now and whenever the page's theme or its
 * content changes. Runs in a page's preload; `report` is only called with a
 * change, so a page that redraws often does not send a message per frame.
 */
export function followTitleBarColors(report: (colors: TitleBarColors) => void): void {
    // The zoom is part of it: the main process sizes the buttons by it, and a
    // zoom changes the device pixel ratio and fires a resize.
    let last = "";
    let queued = false;
    const read = () => {
        queued = false;
        // Just left of where the buttons are: what they are drawn over.
        const overlay = (navigator as Navigator & { windowControlsOverlay?: { getTitlebarAreaRect(): DOMRect; }; })
            .windowControlsOverlay;
        const area = overlay?.getTitlebarAreaRect();
        const x = area && area.width > 0 ? Math.max(0, area.x + area.width - 2) : window.innerWidth - 160;
        const background = backgroundAt(x, 8);
        const key = background ? `${background}@${window.devicePixelRatio}` : "";
        if (!background || key === last) return;
        last = key;
        report({ background, symbol: symbolFor(background) });
    };
    const soon = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(read);
    };
    window.addEventListener("DOMContentLoaded", () => {
        soon();
        // A theme is a class or a style on the root; a new screen can bring a
        // different header.
        new MutationObserver(soon).observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "style", "data-theme"]
        });
        new MutationObserver(soon).observe(document.body, { childList: true });
    });
    window.addEventListener("load", soon);
    window.addEventListener("resize", soon);
}
