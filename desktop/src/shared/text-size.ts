/**
 * The text size somebody chose in their Polaris account (Accessibility), carried
 * into the app's own windows so they read at the size the dashboard does.
 *
 * The dashboard puts the size on its root element as `--app-text-size`; the
 * Polaris window's preload reads it from there and the main process keeps the
 * last one seen, so a window opened while signed out or offline still uses it.
 *
 * Pure, so it can be asserted without Electron.
 */

/** The sizes the dashboard offers (`TEXT_SIZES` in `@polaris/core/schemas/display`,
 *  which the app cannot bundle: it pulls in the dashboard's own dependencies). A
 *  test keeps the two the same. */
export const TEXT_SIZES = [12, 14, 15, 16, 18, 20, 24] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

/** The size before any account has been seen: the dashboard's own default. */
export const DEFAULT_TEXT_SIZE: TextSize = 16;

export function isTextSize(value: unknown): value is TextSize {
    return typeof value === "number" && (TEXT_SIZES as readonly number[]).includes(value);
}

/** A size as the root element carries it, such as "18px", or a bare number;
 *  null for anything that is not one of the offered sizes. */
export function readTextSize(raw: unknown): TextSize | null {
    if (typeof raw === "number") return isTextSize(raw) ? raw : null;
    if (typeof raw !== "string") return null;
    const match = /^\s*(\d{1,3})(?:px)?\s*$/.exec(raw);
    const size = match ? Number(match[1]) : NaN;
    return isTextSize(size) ? size : null;
}

/** How much a layout drawn in pixels for the default size grows at this one. */
export function textScale(size: number): number {
    return (isTextSize(size) ? size : DEFAULT_TEXT_SIZE) / DEFAULT_TEXT_SIZE;
}
