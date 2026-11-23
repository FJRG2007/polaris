/**
 * The desktop app draws the system's minimize, maximize and close buttons over
 * the top right of the page (see `.app-titlebar` in tokens.css). Whatever is
 * pinned to the top edge of the window - a dialog that fills the screen, a side
 * panel, an image viewer, a presentation - would have its own top-right
 * controls under them: there, but unreachable, and in a browser nothing is
 * wrong. `--window-controls-height` is that band's height in the desktop app
 * and 0px everywhere else, so a surface that starts below it looks the same in
 * a browser and stays clickable in the app.
 *
 * One rule instead of a placement at every site: `clearWindowControls` reads the
 * surface's own classes, and wherever it is pinned to the top (`top-0`,
 * `inset-0`, `inset-y-0`, at the base or a phone/tablet width) it moves that edge
 * below the band and takes the band off a full-window height at the same
 * width. The dialog primitives apply it to every dialog; a full-window surface
 * that is not a dialog passes its classes through it.
 */

import { cn } from "../lib/cn";

/** The widths a surface is pinned to the top at. Written out in full, since
 *  Tailwind only generates the classes it finds in the source. */
const AT: Record<string, { top: string; height: string; maxHeight: string; }> = {
    "": {
        top: "top-[var(--window-controls-height)]",
        height: "h-[calc(100dvh-var(--window-controls-height))]",
        maxHeight: "max-h-[calc(100dvh-var(--window-controls-height))]"
    },
    "max-sm:": {
        top: "max-sm:top-[var(--window-controls-height)]",
        height: "max-sm:h-[calc(100dvh-var(--window-controls-height))]",
        maxHeight: "max-sm:max-h-[calc(100dvh-var(--window-controls-height))]"
    },
    "max-md:": {
        top: "max-md:top-[var(--window-controls-height)]",
        height: "max-md:h-[calc(100dvh-var(--window-controls-height))]",
        maxHeight: "max-md:max-h-[calc(100dvh-var(--window-controls-height))]"
    }
};

const PINNED = new Set(["top-0", "inset-0", "inset-y-0"]);
const FULL_HEIGHT = new Set(["h-full", "h-screen", "h-dvh", "h-[100dvh]", "h-[100vh]", "h-svh", "h-lvh"]);
const FULL_MAX_HEIGHT = new Set(["max-h-full", "max-h-screen", "max-h-dvh", "max-h-[100dvh]", "max-h-[100vh]"]);

function split(token: string): { variant: string; base: string; } {
    const at = token.lastIndexOf(":");
    return at < 0 ? { variant: "", base: token } : { variant: token.slice(0, at + 1), base: token.slice(at + 1) };
}

/** The surface's classes with its top edge kept below the desktop app's window
 *  buttons. Unchanged for a surface that is not pinned to the top. */
export function clearWindowControls(className: string | undefined): string {
    const tokens = (className ?? "").split(/\s+/).filter(Boolean);
    const pinned = new Set<string>();
    for (const token of tokens) {
        const { variant, base } = split(token);
        if (PINNED.has(base) && variant in AT) pinned.add(variant);
    }
    if (pinned.size === 0) return className ?? "";
    const extra: string[] = [];
    for (const variant of pinned) extra.push(AT[variant]!.top);
    for (const token of tokens) {
        const { variant, base } = split(token);
        // A full-window height at a width the surface is pinned at loses the
        // band there; one at the base holds at every width it is pinned at.
        const at = variant === "" ? [...pinned] : pinned.has(variant) ? [variant] : [];
        for (const width of at) {
            if (FULL_HEIGHT.has(base)) extra.push(AT[width]!.height);
            if (FULL_MAX_HEIGHT.has(base)) extra.push(AT[width]!.maxHeight);
        }
    }
    return cn(className, ...extra);
}
