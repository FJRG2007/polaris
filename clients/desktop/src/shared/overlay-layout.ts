/**
 * The overlay layer: one see-through window over a display's work area, with the
 * overlay's widgets drawn in it as panels - the way Discord's overlay lays its
 * widgets over a game. Locked, every click goes through the layer except on a
 * panel's clickable regions; unlocked, the layer takes the screen and each
 * panel can be dragged and resized. Where each panel was left is kept.
 *
 * The rules for a panel's place are here, so the main process, the layer's
 * page and the tests share them.
 */

// The tree-shaken build of zod: the layer's page reads this module.
import * as z from "zod/mini";

/** The widgets the layer draws, each one panel. */
export const PANEL_IDS = ["voice"] as const;

export type PanelId = (typeof PANEL_IDS)[number];

/** How wide each panel may be dragged, in pixels at the default text size. */
export const PANEL_WIDTHS = {
    voice: { min: 160, max: 480 }
} as const satisfies Record<PanelId, { min: number; max: number; }>;

/** The most panels a kept layout holds: every widget, with room for later ones. */
export const MAX_PANELS = 16;
/** No screen is wider or taller than this many pixels; a place beyond it is not one. */
const MAX_COORD = 100_000;

const coord = z.int().check(z.minimum(-MAX_COORD), z.maximum(MAX_COORD));
const extent = z.int().check(z.minimum(1), z.maximum(MAX_COORD));

/**
 * Where one panel was left, on the whole desktop: its top-left corner, and the
 * width and height it had. Without a width it takes its own; a panel whose rows
 * grow from the bottom keeps its bottom edge (`y + height`) where it was left.
 * The id is any string so a layout kept by a newer app is read whole.
 */
export const panelPlaceSchema = z.object({
    id: z.string().check(z.minLength(1), z.maxLength(32)),
    x: coord,
    y: coord,
    width: z.optional(extent),
    height: z.optional(extent)
});

export type PanelPlace = z.infer<typeof panelPlaceSchema>;

/** A kept layout: at most one place per panel. */
export const layoutSchema = z.array(panelPlaceSchema).check(z.maxLength(MAX_PANELS));

export type Layout = z.infer<typeof layoutSchema>;

/** A place the layer's page reports after a drag or a resize, in its own pixels. */
export const placeReportSchema = z.strictObject({
    id: z.enum(PANEL_IDS),
    x: coord,
    y: coord,
    width: extent,
    height: extent,
    /** The width was dragged to, not only the panel moved: a width of its own is kept. */
    sized: z.boolean()
});

export type PlaceReport = z.infer<typeof placeReportSchema>;

/** The place kept for one panel, or null for none. */
export function placeOf(layout: readonly PanelPlace[], id: string): PanelPlace | null {
    return layout.find((place) => place.id === id) ?? null;
}

/** The layout with one panel's place kept, or (null) forgotten. */
export function withPlace(layout: readonly PanelPlace[], id: string, place: Omit<PanelPlace, "id"> | null): PanelPlace[] {
    const rest = layout.filter((entry) => entry.id !== id);
    return place ? [...rest, { id, ...place }].slice(-MAX_PANELS) : rest;
}

/**
 * The voice panel's place: the layout's, or - for a widget dragged before
 * there was a layer - the point its window was left at, which is where the
 * panel's top-left corner sits now.
 */
export function voicePlace(layout: readonly PanelPlace[], legacy: { readonly x: number; readonly y: number; } | null): PanelPlace | null {
    return placeOf(layout, "voice") ?? (legacy ? { id: "voice", x: legacy.x, y: legacy.y } : null);
}

/** A rectangle, in whichever pixels the caller works in. */
export interface Rect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** The display a point is on, or null for a point on none. */
export function displayFor<T extends { readonly bounds: Rect; }>(point: { readonly x: number; readonly y: number; }, displays: readonly T[]): T | null {
    return (
        displays.find(({ bounds }) =>
            point.x >= bounds.x && point.y >= bounds.y && point.x < bounds.x + bounds.width && point.y < bounds.y + bounds.height
        ) ?? null
    );
}

/** A panel's top-left corner moved so the whole panel stays inside `area`
 *  (or at its top-left corner, for a panel bigger than it). */
export function clampInside(rect: Rect, area: Rect): { x: number; y: number; } {
    const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - rect.width);
    const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - rect.height);
    return { x: Math.max(x, area.x), y: Math.max(y, area.y) };
}

/** A width dragged to, held between the panel's narrowest and widest at this text scale. */
export function clampWidth(id: PanelId, width: number, scale: number): number {
    const { min, max } = PANEL_WIDTHS[id];
    return Math.round(Math.min(Math.max(width, min * scale), max * scale));
}
