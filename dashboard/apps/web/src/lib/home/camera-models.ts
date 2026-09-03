/**
 * The cameras somebody can actually pick from, by name.
 *
 * A make is not enough to set a camera up. "TP-Link Tapo" covers a doorbell that
 * streams RTSP all day and a battery camera that publishes none and is asleep
 * most of the time, and those two need opposite treatment from Polaris - so the
 * form asked for a make and then left the reader to work out which of three
 * profiles theirs was, from a note.
 *
 * So the model is what is chosen, and the rest follows from it: which protocol
 * Polaris speaks to it, whether it can be pointed, whether it can report its own
 * movement, and whether holding a connection to it costs a charge.
 *
 * What is recorded here is only what the maker publishes. TP-Link lists which of
 * its cameras answer RTSP and ONVIF and which do not, and the split is not a
 * detail of this or that firmware - it is the battery ones, because a protocol
 * built on a permanent connection has nothing to offer a camera whose whole
 * design is not keeping one. Three of their doorbells sit in between and say so
 * in the maker's own words: they answer RTSP only once they are wired for power
 * and set to stay awake, which is exactly the distinction this file carries.
 *
 * A model nobody listed is not a dead end: every brand ends with an entry that
 * takes the profile and asks for the rest, and the last one takes an address and
 * nothing else.
 *
 * Pure and client-safe: the picker and the server read the same list.
 */

import { cameraVendor } from "@/lib/home/vendors";

/** How a camera is powered, which is a question only its owner can answer -
 *  several of these are sold as a battery camera and run just as happily on a
 *  cable, and what Polaris may do with one depends entirely on which. */
export const POWER_SOURCES = ["mains", "battery", "battery-solar"] as const;

export type PowerSource = (typeof POWER_SOURCES)[number];

export const POWER_LABELS: Record<PowerSource, string> = {
    mains: "Plugged in",
    battery: "Battery",
    "battery-solar": "Battery and a solar panel"
};

export const POWER_NOTES: Record<PowerSource, string> = {
    mains: "Polaris treats it like any other camera: it keeps the picture up to date and tells you when it stops answering.",
    battery:
        "Polaris connects only while you are looking. It will not check on it and it will not watch for movement, because both of those mean holding the stream open, which is what empties the battery.",
    "battery-solar":
        "The same as on a battery. A panel replaces what a day costs, not what a permanent connection costs, so nothing here holds one open."
};

/**
 * What it costs to ask Polaris to watch a camera that is running off its own
 * charge, said once and read wherever such a setting is offered.
 *
 * Said rather than prevented. Somebody with a camera on a mains adapter behind a
 * porch light, entered as a battery model, has every right to turn detection on -
 * and somebody with one on a pole deserves to know what they are agreeing to
 * before the camera is dark and they are working out why.
 */
export const BATTERY_COST_WARNING =
    "This camera is running off its own charge, and anything Polaris watches for itself means holding its stream open all day. That is a large increase in what it draws: if it is not recharging faster than that, it will run flat and switch itself off, and Polaris cannot wake it.";

/** One camera anybody can buy. */
export interface CameraModel {
    /** Stable id, stored on the row. Never shown. */
    readonly id: string;
    /** The name on the box. */
    readonly name: string;
    /** Who makes it, as its owner would say it. */
    readonly brand: string;
    /**
     * The ways Polaris can reach it, best first, as profile ids from vendors.ts.
     *
     * More than one is the normal case rather than the exception, and they are
     * not equivalent. A wired Tapo answers RTSP, which is the better transport
     * for video and what its owner most likely already has working - and it also
     * answers TP-Link's own protocol, which needs no camera account and carries
     * two-way audio. Which of those a camera should use is its owner's call, so
     * the list is offered rather than resolved.
     *
     * The first is only the default for a camera being added. One that already
     * exists keeps what it is on, as long as this model still supports it:
     * changing the transport under a working camera is how a picker that was
     * meant to help takes the picture away.
     */
    readonly connections: readonly string[];
    /** Other words somebody might type looking for it - the parent company, the
     *  old name, the way it is written on the invoice. */
    readonly search?: readonly string[];
    /** Whether it can run off a battery at all. Only these are asked how they
     *  are powered; everything else is on a wire by definition. */
    readonly battery?: boolean;
    /** What its owner has to know that is true of this model and not of the
     *  make. */
    readonly note?: string;
}

/**
 * TP-Link's own list of which of its cameras answer RTSP and ONVIF. These get
 * the profile that speaks it.
 */
const TAPO_RTSP = [
    "C100", "C101", "C103", "C104", "C110", "C110P2", "C111", "C113", "C120",
    "C121", "C125", "C200", "C201", "C206", "C207", "C210", "C211", "C216",
    "C217", "C220", "C225", "C230", "C236", "C246D", "C260", "C310", "C320WS",
    "C325WB", "C500", "C510W", "C520WS", "C530WS", "C560WS", "C575D", "C710",
    "C720", "TC53", "TCB72", "TCW30", "TCW61"
] as const;

/** The ones the maker lists as answering neither RTSP nor ONVIF. Every one of
 *  them is a battery camera, and that is the reason rather than a coincidence. */
const TAPO_BATTERY = [
    "C400", "C402", "C410", "C420", "C425", "C460", "C645D", "C660", "D230"
] as const;

/**
 * The three that answer RTSP only under conditions, in the maker's own words:
 * wired for power, with the jumper fitted, and always-on mode turned on. Sold
 * with a battery, so they are asked how they are powered like the rest - and the
 * note is what stops somebody wiring one up and wondering why nothing connects.
 */
const TAPO_CONDITIONAL = ["D225", "D235", "TD25"] as const;

const CONDITIONAL_NOTE =
    "This one answers RTSP only when it is wired for power, has the jumper fitted, and is set to stay awake in the Tapo app. On its battery it publishes nothing, and Polaris reaches it over TP-Link's own protocol instead.";

function tapo(
    name: string,
    connections: readonly string[],
    extra: Partial<CameraModel> = {}
): CameraModel {
    return {
        id: `tapo-${name.toLowerCase()}`,
        name,
        brand: "Tapo",
        connections,
        // Nobody looking for one of these types "Tapo" first. The box says
        // TP-Link and so does the invoice.
        search: ["tp-link", "tplink", "tp link"],
        ...extra
    };
}

/** A wired Tapo answers both, and they are a real choice: RTSP is the better
 *  transport and wants a camera account; TP-Link's own protocol wants only the
 *  account password and carries two-way audio. */
const TAPO_BOTH = ["tapo", "tapo-cloud"] as const;

export const CAMERA_MODELS: readonly CameraModel[] = [
    ...TAPO_BATTERY.map((name) => tapo(name, ["tapo-battery"], { battery: true })),
    // The native protocol first even though RTSP is listed: on these it is the
    // only one that works until the camera is wired up, and offering the wired
    // one as the default would be defaulting to a setup most of them are not in.
    ...TAPO_CONDITIONAL.map((name) =>
        tapo(name, ["tapo-battery", "tapo"], { battery: true, note: CONDITIONAL_NOTE })
    ),
    ...TAPO_RTSP.map((name) => tapo(name, TAPO_BOTH)),
    {
        id: "tapo-other",
        name: "Another Tapo camera",
        brand: "Tapo",
        connections: [...TAPO_BOTH, "tapo-battery"],
        search: ["tp-link", "tplink", "tp link"],
        // Asked rather than assumed: a model nobody here has heard of is as
        // likely to be a battery one as not, and the answer decides whether
        // Polaris may hold a connection to it.
        battery: true
    },
    {
        id: "vigi-other",
        name: "Any VIGI camera",
        brand: "VIGI",
        connections: ["vigi"],
        search: ["tp-link", "tplink", "tp link"]
    },
    { id: "reolink-other", name: "Any Reolink camera", brand: "Reolink", connections: ["reolink"] },
    {
        id: "hikvision-other",
        name: "Any Hikvision camera",
        brand: "Hikvision",
        connections: ["hikvision"]
    },
    { id: "dahua-other", name: "Any Dahua camera", brand: "Dahua", connections: ["dahua"] },
    { id: "amcrest-other", name: "Any Amcrest camera", brand: "Amcrest", connections: ["amcrest"] },
    {
        id: "onvif-other",
        name: "Any ONVIF camera",
        brand: "Other",
        connections: ["onvif"],
        search: ["generic", "any", "other"]
    },
    {
        id: "generic-other",
        name: "Something else",
        brand: "Other",
        connections: ["generic"],
        search: ["generic", "any", "unknown", "rtsp"]
    }
];

/** One model by id, or null for an id from before this list existed. */
export function cameraModel(id: string | null | undefined): CameraModel | null {
    if (!id) return null;
    return CAMERA_MODELS.find((model) => model.id === id) ?? null;
}

/**
 * Whether this camera is being asked to spend its own charge.
 *
 * The model says whether it CAN run off a battery; only its owner knows whether
 * it is. A C425 on a cable behind the porch light is a camera Polaris may watch
 * all day, and the same model on a pole is one it must leave alone - so nothing
 * here reads the model alone.
 */
export function drawsFromBattery(power: string | null | undefined): boolean {
    return power === "battery" || power === "battery-solar";
}

/** Whether the model can be asked how it is powered. Everything else is on a
 *  wire by definition and is not asked a question with one answer. */
export function askPowerFor(modelId: string | null | undefined): boolean {
    return cameraModel(modelId)?.battery === true;
}

/** One value, reduced to what a comparison should ignore: case, spaces and the
 *  hyphens people put in "tp-link" about half the time. */
function fold(value: string): string {
    return value.toLowerCase().replace(/[\s._-]+/g, "");
}

/** Every word a model answers to, folded. */
function wordsFor(model: CameraModel): readonly string[] {
    return [model.name, model.brand, ...(model.search ?? [])].map(fold);
}

/**
 * How well one word matches this model, or null when it does not.
 *
 * Lower is better, and the order is the order somebody expects: the thing they
 * typed exactly, then the thing that starts with it, then the thing that merely
 * contains it.
 */
function scoreWord(model: CameraModel, word: string): number | null {
    const words = wordsFor(model);
    if (words[0] === word) return 0;
    if (words[0]!.startsWith(word)) return 1;
    if (words.some((entry) => entry === word)) return 2;
    if (words.some((entry) => entry.startsWith(word))) return 3;
    if (words.some((entry) => entry.includes(word))) return 4;
    return null;
}

/**
 * What the picker shows for a typed query.
 *
 * Every word has to match something, and they are matched separately: "tapo
 * c410" is a brand and a model, and joining them into one string is a search for
 * a camera called "tapoc410", which nothing is. That is not a corner case - it
 * is how anybody types the name of a camera they own, and it found nothing.
 *
 * Matched against the name on the box AND the name on the invoice: "tplink" has
 * to reach Tapo, because nobody buying one of these thinks of Tapo as the
 * manufacturer.
 *
 * Ordered by how well it matches rather than alphabetically: a search for "c410"
 * that puts C410 fourteenth is a search that did not work.
 */
export function searchModels(query: string): readonly CameraModel[] {
    const asked = query.trim().toLowerCase().split(/\s+/).map(fold).filter(Boolean);
    if (asked.length === 0) return CAMERA_MODELS;
    const scored: { model: CameraModel; score: number }[] = [];
    for (const model of CAMERA_MODELS) {
        const scores = asked.map((word) => scoreWord(model, word));
        // Every word, not any: a second word is somebody narrowing what they
        // meant, and a list that widens when they do is a list that ignored them.
        if (scores.some((score) => score === null)) continue;
        // Ranked on the best word rather than the total, so "tapo c410" ranks on
        // the C410 rather than being dragged down by the brand it shares with
        // fifty others.
        scored.push({ model, score: Math.min(...(scores as number[])) });
    }
    return scored
        .sort(
            (left, right) =>
                left.score - right.score || left.model.name.localeCompare(right.model.name)
        )
        .map((entry) => entry.model);
}

/** The brands, in the order the picker offers them, with how many cameras each
 *  has. The order is the list's own: the makes Polaris knows most about first
 *  and the escape hatches last. */
export function cameraBrands(): readonly { brand: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const model of CAMERA_MODELS) {
        counts.set(model.brand, (counts.get(model.brand) ?? 0) + 1);
    }
    return [...counts.entries()].map(([brand, count]) => ({ brand, count }));
}

/**
 * The makes that survive what has been typed.
 *
 * Matched against the make AND against the cameras under it, so typing a model
 * finds the make that sells it: somebody who knows they have a C410 and not what
 * TP-Link calls its camera brand should not have to guess "Tapo" to get past the
 * first field.
 */
export function searchBrands(query: string): readonly { brand: string; count: number }[] {
    const asked = query.trim();
    if (!asked) return cameraBrands();
    const found = new Set(searchModels(asked).map((model) => model.brand));
    return cameraBrands().filter((entry) => found.has(entry.brand));
}

/** Every camera one brand makes, in the order they are listed. */
export function modelsOfBrand(brand: string): readonly CameraModel[] {
    return CAMERA_MODELS.filter((model) => model.brand === brand);
}

/**
 * How Polaris should reach this camera.
 *
 * `current` is what it is on now, and it wins wherever this model still supports
 * it. That rule is the whole point: somebody editing a camera that has been
 * streaming over RTSP for months, to correct its name, must not have the model
 * they picked quietly move it onto another protocol and take the picture away.
 * The model's own first choice is for a camera that has not been set up yet.
 */
export function vendorForModel(
    modelId: string | null | undefined,
    current?: string | null
): string {
    const model = cameraModel(modelId);
    if (!model) return current || "generic";
    if (current && model.connections.includes(current)) return current;
    return model.connections[0] ?? "generic";
}

/** The ways this model can be reached, for the picker that offers them. Empty
 *  for a model this build does not know, which is what leaves such a camera on
 *  the make it was set up with. */
export function connectionsFor(modelId: string | null | undefined): readonly string[] {
    return cameraModel(modelId)?.connections ?? [];
}

/** Whether a model can be pointed, which is the make's claim narrowed by the
 *  model's own: a battery camera has a fixed lens whatever the make generally
 *  does. */
export function modelCanPan(modelId: string | null | undefined): boolean {
    const model = cameraModel(modelId);
    return model ? model.connections.some((id) => cameraVendor(id).ptz === true) : false;
}
