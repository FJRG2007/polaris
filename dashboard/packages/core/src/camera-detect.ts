/**
 * Turning what a detection model said into what a house cares about.
 *
 * The model answers in its own terms: a flat array of a few thousand candidate
 * boxes, in the coordinates of the square it was fed, labelled with one of
 * eighty classes from a research dataset. None of that is useful to somebody
 * looking at a list of events. This module is the whole distance between the
 * two, and every step of it is arithmetic, so all of it is testable with no
 * model, no camera and no container.
 *
 * The steps, in order:
 *
 *   1. Work out how the frame was fitted into the model's square, so a box can
 *      be put back where it came from.
 *   2. Decode the model's raw output into boxes and scores.
 *   3. Throw away the overlapping duplicates the model produces around every
 *      real thing.
 *   4. Fold eighty research classes into the four a house has an opinion about.
 *   5. Apply the camera's own filters, which is what stops a picture of a rug
 *      being reported as a dog every night.
 *
 * The model itself is YOLOX, which is chosen for being small enough to run on a
 * home server's CPU and licensed the same way Polaris is. Its output convention
 * is documented here rather than assumed: the layout is part of the contract
 * with the file baked into the worker's image, and a model that does not match
 * it is refused rather than half-read.
 */

import { boxArea, boxRatio, intersectionOverUnion, type RelativeBox } from "./camera-zones.js";

/**
 * The eighty classes the model was trained on, in the order it reports them.
 *
 * Written out rather than loaded from a file because the order IS the meaning:
 * index 0 is a person, and a list that drifts by one turns every person into a
 * bicycle without anything failing.
 */
export const COCO_LABELS = [
    "person",
    "bicycle",
    "car",
    "motorcycle",
    "airplane",
    "bus",
    "train",
    "truck",
    "boat",
    "traffic light",
    "fire hydrant",
    "stop sign",
    "parking meter",
    "bench",
    "bird",
    "cat",
    "dog",
    "horse",
    "sheep",
    "cow",
    "elephant",
    "bear",
    "zebra",
    "giraffe",
    "backpack",
    "umbrella",
    "handbag",
    "tie",
    "suitcase",
    "frisbee",
    "skis",
    "snowboard",
    "sports ball",
    "kite",
    "baseball bat",
    "baseball glove",
    "skateboard",
    "surfboard",
    "tennis racket",
    "bottle",
    "wine glass",
    "cup",
    "fork",
    "knife",
    "spoon",
    "bowl",
    "banana",
    "apple",
    "sandwich",
    "orange",
    "broccoli",
    "carrot",
    "hot dog",
    "pizza",
    "donut",
    "cake",
    "chair",
    "couch",
    "potted plant",
    "bed",
    "dining table",
    "toilet",
    "tv",
    "laptop",
    "mouse",
    "remote",
    "keyboard",
    "cell phone",
    "microwave",
    "oven",
    "toaster",
    "sink",
    "refrigerator",
    "book",
    "clock",
    "vase",
    "scissors",
    "teddy bear",
    "hair drier",
    "toothbrush"
] as const;

/**
 * Which of them a house has an opinion about.
 *
 * Everything not named here is discarded before it reaches a filter, which is
 * most of the list: nobody wants to be told about a potted plant. The four
 * groups are the ones the settings screen offers, so what the form promises is
 * what the worker reports.
 *
 * Parcels are the honest compromise. A general model has no class for one, so
 * this is what a box or a bag left in view actually reads as - close enough to
 * be worth reporting, and said that way on the screen rather than promised as
 * parcel detection.
 */
const CLASS_OF: Readonly<Record<string, string>> = {
    person: "person",
    bicycle: "vehicle",
    car: "vehicle",
    motorcycle: "vehicle",
    bus: "vehicle",
    train: "vehicle",
    truck: "vehicle",
    boat: "vehicle",
    bird: "animal",
    cat: "animal",
    dog: "animal",
    horse: "animal",
    sheep: "animal",
    cow: "animal",
    bear: "animal",
    backpack: "package",
    handbag: "package",
    suitcase: "package"
};

/** The class a house calls this, or null when it is not worth a line in a list. */
export function houseClassOf(label: string): string | null {
    return CLASS_OF[label] ?? null;
}

/** One thing the model claims to have seen, in the model's own square. */
export interface ModelDetection {
    /** Index into COCO_LABELS. */
    readonly classIndex: number;
    readonly score: number;
    /** Corners, in model pixels. */
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
}

/** One thing worth reporting, in the frame's own relative coordinates. */
export interface Detection {
    /** What the model called it. */
    readonly label: string;
    /** What a house calls it: person, vehicle, animal or package. */
    readonly houseClass: string;
    /** 0 to 1. */
    readonly score: number;
    readonly box: RelativeBox;
}

/**
 * How a frame is fitted into the model's square.
 *
 * The picture is scaled by one factor in both axes - never stretched - and laid
 * in the top-left corner, with the rest of the square filled with flat grey.
 * Keeping the aspect ratio matters: a model trained on people who are taller
 * than they are wide does measurably worse on people squashed into a square,
 * and the cost of not stretching is arithmetic rather than time.
 *
 * The top-left corner rather than the centre is the model's own convention, and
 * it is the one that makes putting a box back trivial: there is no offset to
 * subtract, only a scale to divide by.
 */
export interface Letterbox {
    /** The single scale applied to both axes. */
    readonly scale: number;
    /** The size the picture occupies inside the square, in model pixels. */
    readonly width: number;
    readonly height: number;
}

/** The grey the empty part of the square is filled with. The model was trained
 *  against this exact value, so it is not a background colour - it is part of
 *  the input format. */
export const LETTERBOX_FILL = 114;

export function letterboxFor(
    sourceWidth: number,
    sourceHeight: number,
    modelSize: number
): Letterbox {
    const scale = Math.min(modelSize / sourceWidth, modelSize / sourceHeight);
    // Truncated, not rounded: this is the size the picture is actually resized
    // to before it is laid into the square, and a half-pixel disagreement here
    // moves every box by a fraction of a percent.
    return {
        scale,
        width: Math.trunc(sourceWidth * scale),
        height: Math.trunc(sourceHeight * scale)
    };
}

/**
 * Put a box from the model's square back onto the frame, as a fraction of it.
 *
 * Dividing by the scale undoes the resize, and dividing by the source size makes
 * it relative - which is the only form anything downstream stores, because a
 * box in pixels is a box that stops meaning anything when the stream's
 * resolution changes.
 */
export function modelBoxToFrame(
    box: { x1: number; y1: number; x2: number; y2: number },
    letterbox: Letterbox,
    sourceWidth: number,
    sourceHeight: number
): RelativeBox {
    const clamp = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);
    return {
        x1: clamp(box.x1 / letterbox.scale / sourceWidth),
        y1: clamp(box.y1 / letterbox.scale / sourceHeight),
        x2: clamp(box.x2 / letterbox.scale / sourceWidth),
        y2: clamp(box.y2 / letterbox.scale / sourceHeight)
    };
}

/** The three resolutions the model looks at the square in. A box is predicted at
 *  every cell of every one of them, which is where the few thousand candidates
 *  come from. */
export const STRIDES = [8, 16, 32] as const;

/** How many candidate rows a square of this size produces. Asserted against the
 *  model's actual output when it loads: if these disagree, the file is not the
 *  model this code was written for and nothing it says can be trusted. */
export function candidateCount(modelSize: number): number {
    return STRIDES.reduce((total, stride) => total + (modelSize / stride) ** 2, 0);
}

/** Values per row: the box, one score for "is anything here", and one per class. */
export const ROW_LENGTH = 4 + 1 + COCO_LABELS.length;

/**
 * Decode the model's raw output.
 *
 * Each row is a box predicted relative to one cell of one of the three grids,
 * and the grid is not in the output - it is implied by the row's position. So
 * the rows are walked in the order the grids were laid out (each stride in turn,
 * each row of cells top to bottom, each cell left to right), and the cell's own
 * coordinates are added back.
 *
 * The two coordinates are offsets from the cell, in cells; the two sizes are
 * logarithms, which is how the model can predict a person and a lorry with the
 * same range of numbers. Both are turned back into model pixels by the stride.
 */
export function decodeDetections(
    output: ArrayLike<number>,
    modelSize: number,
    minScore: number
): ModelDetection[] {
    const detections: ModelDetection[] = [];
    let row = 0;
    for (const stride of STRIDES) {
        const cells = modelSize / stride;
        for (let cellY = 0; cellY < cells; cellY += 1) {
            for (let cellX = 0; cellX < cells; cellX += 1, row += 1) {
                const base = row * ROW_LENGTH;
                if (base + ROW_LENGTH > output.length) return detections;
                const objectness = output[base + 4] ?? 0;
                // Nothing here is worth the eighty comparisons below. This is
                // the check that makes decoding thousands of rows cheap: on a
                // quiet frame almost every row fails it.
                if (objectness < minScore) continue;

                let bestIndex = 0;
                let bestScore = 0;
                for (let index = 0; index < COCO_LABELS.length; index += 1) {
                    const score = output[base + 5 + index] ?? 0;
                    if (score > bestScore) {
                        bestScore = score;
                        bestIndex = index;
                    }
                }
                const score = objectness * bestScore;
                if (score < minScore) continue;

                const centerX = ((output[base] ?? 0) + cellX) * stride;
                const centerY = ((output[base + 1] ?? 0) + cellY) * stride;
                const width = Math.exp(output[base + 2] ?? 0) * stride;
                const height = Math.exp(output[base + 3] ?? 0) * stride;
                detections.push({
                    classIndex: bestIndex,
                    score,
                    x1: centerX - width / 2,
                    y1: centerY - height / 2,
                    x2: centerX + width / 2,
                    y2: centerY + height / 2
                });
            }
        }
    }
    return detections;
}

/**
 * Keep the best box of each cluster and drop the rest.
 *
 * A model predicts a box at every cell that can see a thing, so one person
 * arrives as a dozen near-identical boxes. Sorted by confidence, each box is
 * kept unless it substantially overlaps one already kept - of the same class,
 * because a person carrying a bag genuinely is two things in the same place.
 */
export function suppressOverlaps(
    detections: readonly ModelDetection[],
    threshold = 0.45,
    limit = 20
): ModelDetection[] {
    const sorted = [...detections].sort((a, b) => b.score - a.score);
    const kept: ModelDetection[] = [];
    for (const candidate of sorted) {
        if (kept.length >= limit) break;
        // The corners are model pixels rather than fractions of the frame here,
        // which changes nothing: overlap over union is a ratio, and a ratio has
        // no units.
        const duplicate = kept.some(
            (existing) =>
                existing.classIndex === candidate.classIndex &&
                intersectionOverUnion(existing, candidate) > threshold
        );
        if (!duplicate) kept.push(candidate);
    }
    return kept;
}

/** What a camera will accept as real, per class. The numbers are all fractions
 *  of the frame rather than pixels, so one setting means the same thing on a
 *  doorbell and on a 4K camera. */
export interface DetectionFilter {
    /** Below this the model was guessing. */
    readonly minScore: number;
    /** Smaller than this share of the frame is too far away to be worth a line -
     *  and is where almost all the nonsense lives. */
    readonly minArea: number;
    /** Bigger than this is the camera being blinded, a cobweb on the lens, or a
     *  cat sitting on it. */
    readonly maxArea: number;
    /** Width over height. A person is taller than they are wide, and a box that
     *  says otherwise is a reflection, a shadow or a stripe of wet road. */
    readonly minRatio: number;
    readonly maxRatio: number;
}

/** What a class is judged by when the camera has said nothing more specific.
 *  Person is narrower than the rest because it is the one that raises alarms and
 *  the one a wet pavement imitates. */
export const DEFAULT_FILTERS: Readonly<Record<string, DetectionFilter>> = {
    person: { minScore: 0.5, minArea: 0.0015, maxArea: 0.85, minRatio: 0.12, maxRatio: 1.8 },
    vehicle: { minScore: 0.5, minArea: 0.004, maxArea: 0.95, minRatio: 0.3, maxRatio: 5 },
    animal: { minScore: 0.5, minArea: 0.001, maxArea: 0.6, minRatio: 0.2, maxRatio: 4 },
    package: { minScore: 0.6, minArea: 0.001, maxArea: 0.4, minRatio: 0.3, maxRatio: 3 }
};

export function passesFilter(box: RelativeBox, score: number, filter: DetectionFilter): boolean {
    if (score < filter.minScore) return false;
    if (box.x2 <= box.x1 || box.y2 <= box.y1) return false;
    const area = boxArea(box);
    if (area < filter.minArea || area > filter.maxArea) return false;
    const ratio = boxRatio(box);
    return ratio >= filter.minRatio && ratio <= filter.maxRatio;
}

/**
 * Everything above, in the order it has to happen.
 *
 * Decoding first because it is the cheap filter, then the classes this camera
 * was asked about, then suppression, and the camera's own rules last - so a box
 * rejected for being too small was at least the best box of its cluster.
 *
 * The class filter has to come before suppression rather than after it.
 * Suppression keeps a fixed number of boxes, and the decoder was given the
 * lowest threshold of the wanted classes, so everything the model saw is still
 * in the list: on a busy view a row of chairs and a television can fill every
 * slot by score and crowd out the person the camera was actually watching for,
 * which reads downstream as the detector simply not seeing them.
 */
export function readDetections(input: {
    output: ArrayLike<number>;
    modelSize: number;
    sourceWidth: number;
    sourceHeight: number;
    /** Which house classes this camera was told to care about. Empty reports
     *  none, which is what a camera on a cheaper rung is doing anyway. */
    classes: readonly string[];
    filters?: Readonly<Record<string, DetectionFilter>>;
}): Detection[] {
    const wanted = new Set(input.classes);
    if (wanted.size === 0) return [];
    const filters = input.filters ?? DEFAULT_FILTERS;
    const floor = Math.min(...[...wanted].map((name) => filters[name]?.minScore ?? 0.5));

    const letterbox = letterboxFor(input.sourceWidth, input.sourceHeight, input.modelSize);
    const decoded = decodeDetections(input.output, input.modelSize, floor).filter((candidate) => {
        const houseClass = houseClassOf(COCO_LABELS[candidate.classIndex] ?? "");
        return houseClass !== null && wanted.has(houseClass);
    });
    const detections: Detection[] = [];
    for (const candidate of suppressOverlaps(decoded)) {
        const label = COCO_LABELS[candidate.classIndex];
        if (!label) continue;
        const houseClass = houseClassOf(label);
        if (!houseClass) continue;
        const box = modelBoxToFrame(candidate, letterbox, input.sourceWidth, input.sourceHeight);
        const filter = filters[houseClass] ?? DEFAULT_FILTERS.person!;
        if (!passesFilter(box, candidate.score, filter)) continue;
        detections.push({ label, houseClass, score: candidate.score, box });
    }
    return detections;
}
