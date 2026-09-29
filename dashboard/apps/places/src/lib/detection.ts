/**
 * What a camera is allowed to notice, and what that costs.
 *
 * Detection is a ladder, not a menu. Each rung only runs on what the rung below
 * it already found: nothing looks at a frame until movement was seen, nothing
 * asks "is that a person" until something moved, and nothing asks "who is that"
 * until it was a person. That single rule is what makes a house of cameras
 * affordable - a still garden costs one motion check a second on a postage-stamp
 * stream, and the expensive stages sit idle until something actually happens.
 *
 * The owner picks the highest rung a camera may reach, and where that work runs.
 * Both matter: a camera pointed at a busy street should probably stop at
 * movement, and the machine Polaris itself runs on is rarely the one that should
 * be recognizing faces.
 *
 * Pure and client-safe - the settings form and the pipeline read the same list,
 * so what the form promises is what runs.
 */

/** The rungs, cheapest first. Their order in this array is the ladder. */
export const DETECTORS = ["none", "camera", "motion", "objects", "faces"] as const;

export type Detector = (typeof DETECTORS)[number];

/**
 * One rung. Its words are in the catalog under `detectors.<id>`: a `label`, a
 * `summary` of what it actually does in one line, and its `cost` to the machine
 * it runs on, said plainly rather than in percentages nobody can check. The
 * faces rung also has `requires`: something that has to be set up before it can
 * do its job, in the words of the screen that sets it up. A camera can still be
 * put on the rung without it - it simply stops one step short.
 */
export interface DetectorMeta {
    readonly id: Detector;
    /** Whether the work happens on the camera itself. The two that do are free,
     *  and are why "camera" is the default rather than "motion". */
    readonly onCamera: boolean;
}

export const DETECTOR_META: Readonly<Record<Detector, DetectorMeta>> = {
    none: { id: "none", onCamera: false },
    camera: { id: "camera", onCamera: true },
    motion: { id: "motion", onCamera: false },
    objects: { id: "objects", onCamera: false },
    faces: { id: "faces", onCamera: false }
};

/**
 * "This machine", as the picker offers it.
 *
 * Polaris' own machine is not an enrolled server and has no id, so the choice
 * has to be a word. It is a word only in the form: stored, it is simply no
 * server at all, because that is what every reader of the column already treats
 * null as. Writing the word into the column instead put a value that is not a
 * uuid into a uuid column, and the database said so, in its own language, to
 * whoever was adding a camera.
 */
export const LOCAL_MACHINE = "local";

/** Whether one rung is at or above another - which is the whole gating rule. */
export function detectorReaches(chosen: Detector, stage: Detector): boolean {
    return DETECTORS.indexOf(chosen) >= DETECTORS.indexOf(stage);
}

/** Whether choosing this rung means Polaris runs something itself, and so has to
 *  be told where. */
export function needsSomewhereToRun(detector: Detector): boolean {
    return detector !== "none" && !DETECTOR_META[detector].onCamera;
}

/** The object classes a camera can be told to care about. Deliberately short:
 *  these are the four a house has an opinion about, and a list of eighty is a
 *  list nobody reads. */
export const OBJECT_CLASSES = ["person", "vehicle", "animal", "package"] as const;

export type ObjectClass = (typeof OBJECT_CLASSES)[number];

// Their names are in the catalog under `objects.<class>`. What one of them
// actually means is said only where that is not obvious - `objects.packageHint`,
// honestly: nothing general recognizes a parcel, so what gets reported is a box
// or a bag left in view. Promising parcel detection and delivering that is how a
// setting stops being trusted.

/**
 * How a camera's chosen detector is tuned. Stored as JSON on the camera and read
 * whole, never queried by field.
 */
export interface DetectionSettings {
    /** 1-100. How much has to change before it counts as movement. */
    readonly sensitivity: number;
    /**
     * The shortest gap between two detections on this camera, in seconds.
     *
     * This is the knob that decides what a camera costs. At 30 a doorbell reports
     * a visitor once rather than sixty times, and the expensive stages run twice
     * a minute at worst however busy the view is.
     */
    readonly minGapSeconds: number;
    /**
     * How long movement has to keep going before it counts, in seconds.
     *
     * This is the knob that separates a person from a moth. Nearly every false
     * positive a camera produces is momentary - an insect crossing the lens at
     * night, a gust in a hedge, a lorry shaking the wall - and every one of them
     * is over before this elapses. Something that is still happening two seconds
     * later is something that happened.
     */
    readonly settleSeconds: number;
    /** Which of the classes above are worth reporting, for the object rung. */
    readonly classes: readonly ObjectClass[];
    /** 0-100. How sure the face rung has to be before it puts a name to somebody.
     *  Below it they are reported as a stranger rather than as the nearest match,
     *  which is the failure mode that matters here. */
    readonly faceThreshold: number;
    /** Hours of the day detection is on, as [from, to) in local 24h time. A
     *  camera that only matters at night costs nothing during the day. Null is
     *  all day. */
    readonly hours: { readonly from: number; readonly to: number } | null;
}

export const DEFAULT_DETECTION: DetectionSettings = {
    sensitivity: 50,
    // Half a minute. Chosen so the first thing anybody sets up does not fill the
    // events list with one afternoon of the same cat.
    minGapSeconds: 30,
    // Two seconds. Long enough that a moth, a gust and a passing vibration are
    // all gone before it, short enough that somebody walking past a doorway is
    // still there.
    settleSeconds: 2,
    classes: ["person", "vehicle"],
    // CompreFace's own similarity scale. High enough that a cousin is not
    // greeted by their sibling's name.
    faceThreshold: 85,
    hours: null
};

/** Whether detection should be running at this hour, per the camera's window. */
export function withinHours(settings: DetectionSettings, hour: number): boolean {
    if (!settings.hours) return true;
    const { from, to } = settings.hours;
    // A window that wraps midnight (22 to 6) is the normal case for a house, so
    // it is not an edge case here.
    return from <= to ? hour >= from && hour < to : hour >= from || hour < to;
}
