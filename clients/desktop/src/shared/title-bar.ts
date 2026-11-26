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

// The tree-shaken build of zod, as in `update-ready`: the page's preload reads this.
import * as z from "zod/mini";

const HEX = /^#[0-9a-f]{6}$/;

export const titleBarColorsSchema = z.object({
    background: z.string().check(z.regex(HEX)),
    symbol: z.string().check(z.regex(HEX))
});

export type TitleBarColors = z.infer<typeof titleBarColorsSchema>;

/** How tall the window buttons are at 100%: the dashboard's header, which they
 *  sit in. */
export const TITLE_BAR_HEIGHT = 48;

/** The buttons' height at a page zoom, so they keep lining up with the header
 *  the zoom scaled. They stop above its bottom border: they are drawn over the
 *  page, and over it the line would end where they begin. */
export function overlayHeight(zoom: number): number {
    const factor = Number.isFinite(zoom) && zoom > 0 ? Math.min(Math.max(zoom, 0.25), 5) : 1;
    return Math.round(TITLE_BAR_HEIGHT * factor) - Math.max(1, Math.round(factor));
}

/** The buttons' colours before a page has said what is under them, following
 *  the system's theme. */
export function defaultTitleBarColors(dark: boolean): TitleBarColors {
    return dark ? { background: "#101114", symbol: "#e6e7ea" } : { background: "#ffffff", symbol: "#1c1d21" };
}

/**
 * What a page that is not a dashboard screen - a provider's sign-in during a
 * round trip, a file on the Polaris - is given in a window whose title bar is
 * hidden: it is moved down below the buttons, and the band they
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

/** A colour's channels (0-255) and alpha (0-1). */
export interface Rgba {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly a: number;
}

/** A computed colour - `rgb(...)`, `rgba(...)`, or the `color(srgb ...)` a
 *  newer colour function computes to - or null when it is not one. */
export function rgbaOf(css: string): Rgba | null {
    const value = css.trim();
    const alphaOf = (raw: string | undefined) =>
        raw === undefined ? 1 : raw.endsWith("%") ? parseFloat(raw) / 100 : Number(raw);
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(value);
    const srgb = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/.exec(value);
    const match = rgb ?? srgb;
    if (!match) return null;
    const scale = rgb ? 1 : 255;
    const [r, g, b] = [match[1], match[2], match[3]].map((channel) => Math.min(255, Number(channel) * scale)) as [
        number,
        number,
        number
    ];
    const a = Math.min(1, Math.max(0, alphaOf(match[4])));
    return [r, g, b, a].every(Number.isFinite) ? { r, g, b, a } : null;
}

/**
 * What shows through a stack of layers, top first: each one's colour over
 * everything under it. Null when nothing in the stack is opaque enough to say.
 *
 * The buttons are one flat colour, so they have to be what the eye sees there,
 * not the first opaque thing under them: with a dialog open the page under the
 * buttons is dimmed by its backdrop, and reading past the backdrop to the page
 * painted the buttons the undimmed colour - a light block in the corner of a
 * dark screen.
 */
export function composite(layers: readonly Rgba[]): string | null {
    let left = 1;
    const sum = { r: 0, g: 0, b: 0 };
    for (const layer of layers) {
        if (layer.a <= 0) continue;
        sum.r += layer.r * layer.a * left;
        sum.g += layer.g * layer.a * left;
        sum.b += layer.b * layer.a * left;
        left *= 1 - layer.a;
        if (left < 0.004) break;
    }
    if (left >= 0.004) return null;
    const hex = (value: number) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
    return `#${hex(sum.r)}${hex(sum.g)}${hex(sum.b)}`;
}

/** The colour the eye sees at a point: every layer drawn there, top first,
 *  with its own opacity and its ancestors' folded in. */
function backgroundAt(x: number, y: number): string | null {
    const layers: Rgba[] = [];
    for (const node of document.elementsFromPoint(x, y)) {
        const colour = rgbaOf(getComputedStyle(node).backgroundColor);
        if (!colour || colour.a === 0) continue;
        let opacity = 1;
        for (let up: Element | null = node; up; up = up.parentElement) opacity *= Number(getComputedStyle(up).opacity) || 0;
        layers.push({ ...colour, a: colour.a * opacity });
    }
    return composite(layers);
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
    // A dialog's backdrop fades in: read again once it has, or the buttons keep
    // the colour of its first frame.
    document.addEventListener("transitionend", soon, true);
    document.addEventListener("animationend", soon, true);
    window.addEventListener("resize", soon);
}
