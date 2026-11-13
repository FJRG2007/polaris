/**
 * The arithmetic behind the map, kept apart from it so it can be tested on its
 * own: where a latitude and longitude land on the pre-projected outlines, how
 * the view moves when somebody zooms or drags, and which places are drawn as
 * one marker because they would sit on top of each other at this zoom.
 *
 * Everything is in the outline file's own units (960 wide), the units the
 * SVG's viewBox is in. A view is the transform `translate(x, y) scale(zoom)`
 * applied to the outlines.
 */

/** Mercator as `scripts/gen-world-map.mjs` drew the outlines: d3-geo's, unrotated. */
export interface Projection {
    readonly k: number;
    readonly tx: number;
    readonly ty: number;
}

export interface Size {
    readonly w: number;
    readonly h: number;
}

export interface View {
    readonly zoom: number;
    readonly x: number;
    readonly y: number;
}

export interface Point {
    readonly x: number;
    readonly y: number;
}

/** [left, top, right, bottom]. */
export type Box = readonly [number, number, number, number];

/** Enough to tell the houses of one street apart on 1:110m outlines is not the goal; towns are. */
export const MAX_ZOOM = 24;
export const WHOLE: View = { zoom: 1, x: 0, y: 0 };

/** Mercator runs to infinity at the poles; this is where every web map stops. */
const LIMIT = 85.05112878;
const RADIANS = Math.PI / 180;

export function project(projection: Projection, latitude: number, longitude: number): Point {
    const phi = Math.max(-LIMIT, Math.min(LIMIT, latitude)) * RADIANS;
    return {
        x: projection.tx + projection.k * longitude * RADIANS,
        y: projection.ty - projection.k * Math.log(Math.tan(Math.PI / 4 + phi / 2))
    };
}

export function unproject(
    projection: Projection,
    point: Point
): { latitude: number; longitude: number } {
    const longitude = (point.x - projection.tx) / projection.k / RADIANS;
    const latitude =
        (2 * Math.atan(Math.exp((projection.ty - point.y) / projection.k)) - Math.PI / 2) / RADIANS;
    return { latitude, longitude: Math.max(-180, Math.min(180, longitude)) };
}

/** Where a point of the outlines is drawn under a view. */
export function onScreen(view: View, point: Point): Point {
    return { x: point.x * view.zoom + view.x, y: point.y * view.zoom + view.y };
}

/** The point of the outlines under a spot of the drawn map. */
export function onMap(view: View, point: Point): Point {
    return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}

/** The view, held to a zoom in range and to the map always filling its box. */
export function clamp(view: View, size: Size): View {
    const zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom));
    return {
        zoom,
        x: Math.max(size.w - size.w * zoom, Math.min(0, view.x)),
        y: Math.max(size.h - size.h * zoom, Math.min(0, view.y))
    };
}

/** Zoom by a factor, keeping the point under `at` (a spot of the drawn map) where it is. */
export function zoomAt(view: View, factor: number, at: Point, size: Size): View {
    const anchor = onMap(view, at);
    const zoom = Math.max(1, Math.min(MAX_ZOOM, view.zoom * factor));
    return clamp({ zoom, x: at.x - anchor.x * zoom, y: at.y - anchor.y * zoom }, size);
}

export function panBy(view: View, dx: number, dy: number, size: Size): View {
    return clamp({ zoom: view.zoom, x: view.x + dx, y: view.y + dy }, size);
}

/** The view that shows a box of the outlines whole and centred, with `pad` around it. */
export function fit(box: Box, size: Size, pad: number, maxZoom = MAX_ZOOM): View {
    const [left, top, right, bottom] = box;
    const zoom = Math.max(
        1,
        Math.min(
            maxZoom,
            size.w / Math.max(right - left + 2 * pad, 1e-6),
            size.h / Math.max(bottom - top + 2 * pad, 1e-6)
        )
    );
    const cx = (left + right) / 2;
    const cy = (top + bottom) / 2;
    return clamp({ zoom, x: size.w / 2 - cx * zoom, y: size.h / 2 - cy * zoom }, size);
}

export function boxOf(points: readonly Point[]): Box {
    let box: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const { x, y } of points) {
        box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)];
    }
    return box;
}

export interface Located<T> extends Point {
    readonly item: T;
}

export interface Cluster<T> extends Point {
    /** Stable for the same members, so a cluster that was opened stays open. */
    readonly key: string;
    readonly members: readonly Located<T>[];
}

/**
 * Places closer than `radius` on screen become one marker, the way map pickers
 * have grouped them since Leaflet.markercluster: greedy, in the given order, so
 * the result never changes between two draws of the same view. The marker sits
 * at the members' middle. `id` names a member for the cluster's key.
 */
export function cluster<T>(
    points: readonly Located<T>[],
    view: View,
    radius: number,
    id: (item: T) => string
): Cluster<T>[] {
    const groups: { sx: number; sy: number; members: Located<T>[] }[] = [];
    for (const point of points) {
        const at = onScreen(view, point);
        const near = groups.find((group) => {
            const n = group.members.length;
            return Math.hypot(group.sx / n - at.x, group.sy / n - at.y) < radius;
        });
        if (near) {
            near.members.push(point);
            near.sx += at.x;
            near.sy += at.y;
        } else {
            groups.push({ sx: at.x, sy: at.y, members: [point] });
        }
    }
    return groups.map(({ members }) => ({
        key: members
            .map((member) => id(member.item))
            .sort()
            .join("|"),
        members,
        x: members.reduce((sum, member) => sum + member.x, 0) / members.length,
        y: members.reduce((sum, member) => sum + member.y, 0) / members.length
    }));
}

/**
 * What pressing a cluster does: zoom until its members come apart, or, when no
 * zoom would part them (one town, one spot), lay them out around it instead.
 */
export function openCluster(
    members: readonly Point[],
    size: Size,
    radius: number
): { readonly kind: "zoom"; readonly view: View } | { readonly kind: "fan" } {
    const box = boxOf(members);
    const span = Math.max(box[2] - box[0], box[3] - box[1]);
    if (span * MAX_ZOOM < radius) return { kind: "fan" };
    return { kind: "zoom", view: fit(box, size, Math.max(span * 0.25, radius / MAX_ZOOM)) };
}

/** `count` spots around a centre, `radius` from it, the first at the top. */
export function fan(center: Point, count: number, radius: number): Point[] {
    return Array.from({ length: count }, (_, index) => {
        const angle = -Math.PI / 2 + (2 * Math.PI * index) / count;
        return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) };
    });
}
