/**
 * The parts of a camera's picture that matter, and the ones that never do.
 *
 * A camera sees one rectangle and has no opinion about it. Almost every useless
 * alert a house produces comes from that: the road at the bottom of the drive,
 * the tree by the fence, the neighbour's door. Nothing about those is a
 * detection problem - the detector is right, a car really did go past - and no
 * amount of sensitivity fixes them, because the thing being seen is genuinely
 * there. What is needed is a way to say where in the picture Polaris is looking,
 * and that is a zone.
 *
 * Two kinds, and no more:
 *
 *   - watch: an area that counts. If a camera has any, something only counts
 *     when it is standing in one of them, and the event records which. This is
 *     how "tell me about the driveway" is said.
 *   - ignore: an area that never counts. Movement inside it is not movement, and
 *     something detected standing in it is dropped before anything expensive is
 *     asked about it. This is the road and the tree.
 *
 * Everything here is pure and client-safe: the editor draws the same polygons
 * the worker tests against, out of the same functions, so a zone cannot look
 * right on the screen and behave differently on the machine watching.
 *
 * Coordinates are relative - 0 to 1 across the frame, in both axes. A zone is
 * drawn on whatever size picture the browser happened to load and tested against
 * whatever size frame the detector happened to decode, and those are never the
 * same number. Storing pixels means a zone silently moves the day a camera's
 * stream changes resolution, which is the kind of fault nobody attributes to the
 * right cause.
 */

/** The kinds, in the order they are offered. */
export const ZONE_KINDS = ["watch", "ignore"] as const;

export type ZoneKind = (typeof ZONE_KINDS)[number];

export interface ZoneKindMeta {
    readonly id: ZoneKind;
    readonly label: string;
    readonly summary: string;
}

export const ZONE_KIND_META: Readonly<Record<ZoneKind, ZoneKindMeta>> = {
    watch: {
        id: "watch",
        label: "Watch this area",
        summary: "Only what happens inside counts. Draw more than one and any of them will do."
    },
    ignore: {
        id: "ignore",
        label: "Ignore this area",
        summary:
            "Nothing here is ever reported. The road, the pavement, the tree that moves all afternoon."
    }
};

/** A point on the frame, 0 to 1 in each axis. */
export interface ZonePoint {
    readonly x: number;
    readonly y: number;
}

/** A box the detector reported, in the same relative coordinates. */
export interface RelativeBox {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
}

/** A zone as everything downstream reads it. The database row is wider; this is
 *  the part that decides anything. */
export interface Zone {
    readonly id: string;
    readonly name: string;
    readonly kind: ZoneKind;
    /** The outline, in order. Three points at least, or it is not an area. */
    readonly points: readonly ZonePoint[];
    /** Which classes count here, or empty for all of them. A driveway that only
     *  cares about people and a gate that only cares about vehicles are the same
     *  camera. */
    readonly objects: readonly string[];
    /** How many frames running something has to be standing in it before it is
     *  counted as being in it. A detector's box wobbles by a few pixels every
     *  frame, and on a boundary that reads as somebody stepping in and out twice
     *  a second. */
    readonly inertia: number;
    /** How long it has to stay before it counts at all, in seconds. Zero is the
     *  normal case; a car park that only cares about somebody who stopped is
     *  not. */
    readonly loiterSeconds: number;
    readonly enabled: boolean;
}

/** The fewest points that enclose anything. */
export const MIN_ZONE_POINTS = 3;

/** More than this and the outline is being traced rather than drawn, and every
 *  frame pays for it. */
export const MAX_ZONE_POINTS = 32;

/**
 * Whether a point is inside a polygon.
 *
 * Ray casting: count how many edges a line drawn to the right crosses. An odd
 * number is inside. It handles a concave outline, which matters - a drive that
 * bends around a corner is drawn concave by everybody who draws one.
 */
export function pointInPolygon(point: ZonePoint, polygon: readonly ZonePoint[]): boolean {
    if (polygon.length < MIN_ZONE_POINTS) return false;
    let inside = false;
    for (
        let index = 0, previous = polygon.length - 1;
        index < polygon.length;
        previous = index, index += 1
    ) {
        const a = polygon[index]!;
        const b = polygon[previous]!;
        // Only edges that straddle the point's row can be crossed by the ray.
        if (a.y > point.y === b.y > point.y) continue;
        const crossingX = ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
        if (point.x < crossingX) inside = !inside;
    }
    return inside;
}

/**
 * The point on a box that decides which zone it is in.
 *
 * The bottom edge, in the middle: where the thing is standing. Using the centre
 * of the box instead is the classic mistake - a person at the near edge of a
 * drive has a box whose centre is over the pavement behind them, and they are
 * reported as being on the pavement. What matters is where their feet are.
 */
export function groundPoint(box: RelativeBox): ZonePoint {
    return { x: (box.x1 + box.x2) / 2, y: box.y2 };
}

/** How much of the frame a box covers, 0 to 1. */
export function boxArea(box: RelativeBox): number {
    return Math.max(0, box.x2 - box.x1) * Math.max(0, box.y2 - box.y1);
}

/** Width over height. A person is tall, a car is wide, and a reflection on a wet
 *  road is a stripe - which is what this is for. */
export function boxRatio(box: RelativeBox): number {
    const height = box.y2 - box.y1;
    return height > 0 ? (box.x2 - box.x1) / height : 0;
}

/** How much two boxes overlap, as a share of the space they cover between them.
 *  This is what says the box in this frame is the same thing as the box in the
 *  last one. */
export function intersectionOverUnion(a: RelativeBox, b: RelativeBox): number {
    const width = Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1);
    const height = Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
    if (width <= 0 || height <= 0) return 0;
    const overlap = width * height;
    const union = boxArea(a) + boxArea(b) - overlap;
    return union > 0 ? overlap / union : 0;
}

/** Whether a box touches the edge of the frame, which almost always means the
 *  thing is half out of shot. A picture of half a person is a worse picture than
 *  one of all of them, however confident the detector was. */
export function onEdge(box: RelativeBox, margin = 0.01): boolean {
    return box.x1 <= margin || box.y1 <= margin || box.x2 >= 1 - margin || box.y2 >= 1 - margin;
}

/** Whether a zone has anything to say about this class. */
export function zoneAdmits(zone: Zone, label: string): boolean {
    return zone.objects.length === 0 || zone.objects.includes(label);
}

/** Whether a box's ground point falls inside a zone that cares about its class. */
export function zoneContains(zone: Zone, box: RelativeBox, label: string): boolean {
    if (!zone.enabled || !zoneAdmits(zone, label)) return false;
    return pointInPolygon(groundPoint(box), zone.points);
}

/**
 * Whether this is somewhere Polaris was told never to look.
 *
 * Asked before anything else and answered with the ground point, so a person
 * standing on the pavement is ignored even though the top of their box is over
 * the garden.
 */
export function isIgnored(zones: readonly Zone[], box: RelativeBox, label: string): boolean {
    return zones.some((zone) => zone.kind === "ignore" && zoneContains(zone, box, label));
}

/** The watch zones a box is standing in, by name. */
export function zonesContaining(zones: readonly Zone[], box: RelativeBox, label: string): string[] {
    return zones
        .filter((zone) => zone.kind === "watch" && zoneContains(zone, box, label))
        .map((zone) => zone.name);
}

/**
 * Whether a camera's zones allow this to be reported at all.
 *
 * The rule in one sentence: an ignore zone always wins, and if the camera has
 * any watch zones at all then something has to be standing in one. A camera with
 * no zones reports everything, which is what every camera does today and what a
 * camera added tomorrow should keep doing until somebody draws on it.
 */
export function zonesAllow(zones: readonly Zone[], box: RelativeBox, label: string): boolean {
    if (isIgnored(zones, box, label)) return false;
    const watching = zones.filter(
        (zone) => zone.kind === "watch" && zone.enabled && zoneAdmits(zone, label)
    );
    if (watching.length === 0) return true;
    return watching.some((zone) => pointInPolygon(groundPoint(box), zone.points));
}

/**
 * How long something has been standing in each zone.
 *
 * Kept per tracked object and advanced once a frame. Two counters, and they do
 * different jobs. `presence` is the wobble filter: a box on a boundary has to be
 * inside for `inertia` frames running before it counts, and one frame outside
 * takes one frame off rather than resetting it, so a jittering box settles
 * instead of oscillating. `loiter` is the "and stayed" rule, and only starts
 * once presence is satisfied.
 */
export interface ZonePresence {
    readonly presence: Readonly<Record<string, number>>;
    readonly loiter: Readonly<Record<string, number>>;
    /** The zones it is in right now, having passed both. */
    readonly current: readonly string[];
    /** Every zone it has been in during this object's life. This is what an event
     *  records - somebody who walked up the drive and is now at the door was in
     *  both. */
    readonly entered: readonly string[];
}

export const NO_PRESENCE: ZonePresence = { presence: {}, loiter: {}, current: [], entered: [] };

/**
 * Advance one tracked object's zone state by a frame.
 *
 * Pure: the state goes in and a new state comes out, so the whole business of
 * inertia and loitering can be exercised frame by frame in a test with no
 * camera, no model and no clock.
 */
export function advancePresence(
    state: ZonePresence,
    zones: readonly Zone[],
    box: RelativeBox,
    label: string,
    fps: number
): ZonePresence {
    const presence: Record<string, number> = { ...state.presence };
    const loiter: Record<string, number> = { ...state.loiter };
    const current: string[] = [];
    const entered = [...state.entered];

    for (const zone of zones) {
        if (zone.kind !== "watch" || !zone.enabled || !zoneAdmits(zone, label)) continue;
        const inside = pointInPolygon(groundPoint(box), zone.points);
        const score = presence[zone.name] ?? 0;

        if (!inside) {
            // Walk it back rather than dropping it: one frame where the box
            // slipped over the line is not somebody leaving.
            if (score > 1) presence[zone.name] = score - 1;
            else delete presence[zone.name];
            delete loiter[zone.name];
            continue;
        }

        const next = score + 1;
        presence[zone.name] = next;
        if (next < Math.max(1, zone.inertia)) continue;

        const needed = Math.max(0, zone.loiterSeconds) * Math.max(1, fps);
        const stayed = (loiter[zone.name] ?? 0) + 1;
        loiter[zone.name] = stayed;
        if (stayed < needed) continue;

        current.push(zone.name);
        if (!entered.includes(zone.name)) entered.push(zone.name);
    }

    return { presence, loiter, current, entered };
}

/** A polygon as an SVG `points` attribute at a given size, which is how both the
 *  editor and the picture drawn over an event render one. */
export function polygonPoints(points: readonly ZonePoint[], width: number, height: number): string {
    return points
        .map((point) => `${(point.x * width).toFixed(1)},${(point.y * height).toFixed(1)}`)
        .join(" ");
}

/** Read points off a stored row, dropping anything that is not a pair of numbers
 *  in range. A zone is drawn by a person and stored as text; it is read back
 *  defensively rather than trusted. */
export function parseZonePoints(value: unknown): ZonePoint[] {
    const raw = typeof value === "string" ? safeJson(value) : value;
    if (!Array.isArray(raw)) return [];
    const points: ZonePoint[] = [];
    for (const entry of raw.slice(0, MAX_ZONE_POINTS)) {
        const pair = Array.isArray(entry) ? entry : null;
        const x = Number(pair?.[0]);
        const y = Number(pair?.[1]);
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        points.push({ x: clamp01(x), y: clamp01(y) });
    }
    return points.length >= MIN_ZONE_POINTS ? points : [];
}

/** The storage shape: pairs, not objects, because a polygon of thirty points is
 *  written to a column and `[[0.1,0.2],...]` is a third the size of the same
 *  thing with keys. */
export function serializeZonePoints(points: readonly ZonePoint[]): string {
    return JSON.stringify(points.map((point) => [round3(point.x), round3(point.y)]));
}

/** A list of class names off a stored row, kept to what the caller recognizes. */
export function parseZoneObjects(value: unknown, allowed: readonly string[]): string[] {
    const raw = typeof value === "string" ? safeJson(value) : value;
    if (!Array.isArray(raw)) return [];
    return raw.filter(
        (entry): entry is string => typeof entry === "string" && allowed.includes(entry)
    );
}

function safeJson(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Three decimals is a thousandth of the frame - finer than anybody can draw and
 *  finer than any detector's box is accurate to. */
function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}
