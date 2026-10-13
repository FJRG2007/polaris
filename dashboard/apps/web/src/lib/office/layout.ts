/**
 * Whether the Office home draws a grid of previews or rows, as this browser last
 * chose. A convenience of one viewer's, so it lives in this browser and nowhere
 * else; storage that is blocked or full simply means the grid every time.
 */

export const OFFICE_LAYOUTS = ["grid", "list"] as const;

export type OfficeLayout = (typeof OFFICE_LAYOUTS)[number];

export const OFFICE_LAYOUT_KEY = "polaris.office.layout";

/** What was kept, read back; the grid for anything else. */
export function parseOfficeLayout(value: unknown): OfficeLayout {
    return value === "list" ? "list" : "grid";
}

export function readOfficeLayout(): OfficeLayout {
    try {
        return parseOfficeLayout(window.localStorage.getItem(OFFICE_LAYOUT_KEY));
    } catch {
        return "grid";
    }
}

export function writeOfficeLayout(layout: OfficeLayout): void {
    try {
        window.localStorage.setItem(OFFICE_LAYOUT_KEY, layout);
    } catch {
        // Not kept: the next visit opens on the grid, which is the default.
    }
}
