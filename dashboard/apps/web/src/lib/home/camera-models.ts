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

/** One camera anybody can buy. */
export interface CameraModel {
    /** Stable id, stored on the row. Never shown. */
    readonly id: string;
    /** The name on the box. */
    readonly name: string;
    /** Who makes it, as its owner would say it. */
    readonly brand: string;
    /** The profile in vendors.ts that says how to talk to it. */
    readonly vendor: string;
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

function tapo(name: string, vendor: string, extra: Partial<CameraModel> = {}): CameraModel {
    return {
        id: `tapo-${name.toLowerCase()}`,
        name,
        brand: "Tapo",
        vendor,
        // Nobody looking for one of these types "Tapo" first. The box says
        // TP-Link and so does the invoice.
        search: ["tp-link", "tplink", "tp link"],
        ...extra
    };
}

export const CAMERA_MODELS: readonly CameraModel[] = [
    ...TAPO_BATTERY.map((name) => tapo(name, "tapo-battery", { battery: true })),
    ...TAPO_CONDITIONAL.map((name) =>
        tapo(name, "tapo-battery", { battery: true, note: CONDITIONAL_NOTE })
    ),
    ...TAPO_RTSP.map((name) => tapo(name, "tapo-cloud")),
    {
        id: "tapo-other",
        name: "Another Tapo camera",
        brand: "Tapo",
        vendor: "tapo-cloud",
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
        vendor: "vigi",
        search: ["tp-link", "tplink", "tp link"]
    },
    { id: "reolink-other", name: "Any Reolink camera", brand: "Reolink", vendor: "reolink" },
    { id: "hikvision-other", name: "Any Hikvision camera", brand: "Hikvision", vendor: "hikvision" },
    { id: "dahua-other", name: "Any Dahua camera", brand: "Dahua", vendor: "dahua" },
    { id: "amcrest-other", name: "Any Amcrest camera", brand: "Amcrest", vendor: "amcrest" },
    {
        id: "onvif-other",
        name: "Any ONVIF camera",
        brand: "Other",
        vendor: "onvif",
        search: ["generic", "any", "other"]
    },
    {
        id: "generic-other",
        name: "Something else",
        brand: "Other",
        vendor: "generic",
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

/**
 * What the picker shows for a typed query.
 *
 * Matched against the brand, the name and the words somebody would actually
 * type - "tplink" has to find Tapo, because that is the name on the box and it
 * is not the name in this list. Ordered by how well it matches rather than
 * alphabetically: a search for "c410" that puts C410 fourteenth is a search that
 * did not work.
 */
export function searchModels(query: string): readonly CameraModel[] {
    const asked = query.trim().toLowerCase().replace(/[\s-]+/g, "");
    if (!asked) return CAMERA_MODELS;
    const scored: { model: CameraModel; score: number }[] = [];
    for (const model of CAMERA_MODELS) {
        const name = model.name.toLowerCase().replace(/[\s-]+/g, "");
        const words = [name, model.brand.toLowerCase(), ...(model.search ?? [])].map((word) =>
            word.toLowerCase().replace(/[\s-]+/g, "")
        );
        if (name === asked) scored.push({ model, score: 0 });
        else if (name.startsWith(asked)) scored.push({ model, score: 1 });
        else if (words.some((word) => word.startsWith(asked))) scored.push({ model, score: 2 });
        else if (words.some((word) => word.includes(asked))) scored.push({ model, score: 3 });
    }
    return scored
        .sort(
            (left, right) =>
                left.score - right.score || left.model.name.localeCompare(right.model.name)
        )
        .map((entry) => entry.model);
}

/** The profile a chosen model uses, falling back to the generic one for a model
 *  this build does not know. */
export function vendorForModel(modelId: string | null | undefined): string {
    return cameraModel(modelId)?.vendor ?? "generic";
}

/** Whether a model can be pointed, which is the make's claim narrowed by the
 *  model's own: a battery camera has a fixed lens whatever the make generally
 *  does. */
export function modelCanPan(modelId: string | null | undefined): boolean {
    const model = cameraModel(modelId);
    return model ? cameraVendor(model.vendor).ptz === true : false;
}
