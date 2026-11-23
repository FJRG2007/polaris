/**
 * The screen widths the top bar's `tb-*` and `under-tb-*` variants are measured
 * against, in px - Tailwind's default screens, which the preset does not
 * change. One list for the preset, which writes the variants, and for
 * `TitlebarWidths`, which tells the page outside the bar what the bar has room
 * for.
 */
export const TITLEBAR_SCREENS: Readonly<Record<string, number>> = {
    sm: 640,
    md: 768,
    lg: 1024,
    xl: 1280,
    "2xl": 1536
};

/** The screens the bar is narrower than, as `data-titlebar-under` lists them. */
export function titlebarUnder(width: number): string {
    return Object.entries(TITLEBAR_SCREENS)
        .filter(([, min]) => width < min)
        .map(([name]) => name)
        .join(" ");
}
