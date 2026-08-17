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

export interface DetectorMeta {
    readonly id: Detector;
    readonly label: string;
    /** What it actually does, in one line. */
    readonly summary: string;
    /** What it costs the machine it runs on, said plainly rather than in
     *  percentages nobody can check. */
    readonly cost: string;
    /** Whether the work happens on the camera itself. The two that do are free,
     *  and are why "camera" is the default rather than "motion". */
    readonly onCamera: boolean;
    /** A marketplace app this rung needs before it can be chosen. */
    readonly requiresApp?: string;
}

export const DETECTOR_META: Readonly<Record<Detector, DetectorMeta>> = {
    none: {
        id: "none",
        label: "Nothing",
        summary: "Watch it live, and record if you asked for that. Nothing is analyzed.",
        cost: "None.",
        onCamera: false
    },
    camera: {
        id: "camera",
        label: "The camera's own alerts",
        summary: "Let the camera decide something moved and tell Polaris. Most cameras made in the last ten years can.",
        cost: "None. The camera does the work and Polaris only listens.",
        onCamera: true
    },
    motion: {
        id: "motion",
        label: "Movement",
        summary: "Polaris watches the small stream for movement. Use it when the camera cannot report its own, or reports far too much.",
        cost: "Small. One low-resolution frame a second, no video decoding of the good stream.",
        onCamera: false
    },
    objects: {
        id: "objects",
        label: "People, vehicles and animals",
        summary: "When something moves, Polaris looks at that frame and says what it was. This is what stops a swaying branch waking the house.",
        cost: "Moderate, and only while something is moving. Idle the rest of the time.",
        onCamera: false
    },
    faces: {
        id: "faces",
        label: "Who it is",
        summary: "When a person is seen, compare their face against the people you have taught it. Everybody else is reported as a stranger.",
        cost: "Highest, and rarest: it only runs on frames that already had a person in them.",
        onCamera: false,
        requiresApp: "compreface"
    }
};

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

export const OBJECT_CLASS_LABELS: Readonly<Record<ObjectClass, string>> = {
    person: "People",
    vehicle: "Vehicles",
    animal: "Animals",
    package: "Parcels"
};

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
