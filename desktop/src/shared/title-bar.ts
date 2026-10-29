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
        if (!background || background === last) return;
        last = background;
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
}
