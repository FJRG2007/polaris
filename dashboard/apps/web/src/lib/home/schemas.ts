/**
 * What a camera's settings have to look like, for the form and for the server.
 *
 * One schema and one normalizer, imported by both, so the browser cannot be
 * shown a rule the server does not enforce and the server cannot reject
 * something the form called fine. Normalizing runs first and everywhere: a
 * hostname typed with a capital, a path pasted without its leading slash and a
 * name with a trailing space are the same camera, and deciding that at the last
 * moment is how a house ends up with two of it.
 */

import { z } from "zod";
import { DETECTORS, LOCAL_MACHINE, OBJECT_CLASSES } from "@/lib/home/detection";
import { MAX_ZONE_POINTS, MIN_ZONE_POINTS, ZONE_KINDS } from "@polaris/core";

/** How a camera's address is written down, whatever was typed. Hostnames are
 *  case-insensitive and an address is compared, so it is lowered; an IP is
 *  unaffected by that. Any scheme or path somebody pasted in front is dropped -
 *  people paste whole RTSP URLs into address fields, and always will. */
export function normalizeAddress(value: string): string {
    const trimmed = value.trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
    return (trimmed.split("/")[0] ?? "").replace(/\/+$/, "").toLowerCase();
}

/** A stream path as the camera wants it: leading slash, no trailing one, and
 *  empty left empty (which means "ask the camera"). */
export function normalizeStreamPath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) return "";
    const withoutHost = trimmed.replace(/^rtsp:\/\/[^/]+/i, "");
    const path = withoutHost.startsWith("/") ? withoutHost : `/${withoutHost}`;
    return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

/** Everything a camera row's editable text is put through, on both sides. */
export function normalizeCameraInput<T extends Record<string, unknown>>(input: T): T {
    const value = { ...input } as Record<string, unknown>;
    if (typeof value.name === "string") value.name = value.name.trim();
    if (typeof value.zone === "string") value.zone = value.zone.trim();
    if (typeof value.address === "string") value.address = normalizeAddress(value.address);
    if (typeof value.mainPath === "string") value.mainPath = normalizeStreamPath(value.mainPath);
    if (typeof value.subPath === "string") value.subPath = normalizeStreamPath(value.subPath);
    if (typeof value.username === "string") value.username = value.username.trim();
    return value as T;
}

/** What the database will accept where it wants a uuid. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A host or address, once normalized. Deliberately permissive about shape - a
 *  camera can be at an IP, a hostname, or a name only the local network knows -
 *  and strict about what cannot be in one. */
const addressSchema = z
    .string()
    .trim()
    .min(1, "Where is the camera?")
    .max(255)
    .refine(
        (value) => !/[\s@/\\]/.test(value),
        "Just the address: no slashes, spaces or credentials"
    );

const portSchema = z.coerce.number().int().min(1).max(65535);

export const detectionSettingsSchema = z.object({
    sensitivity: z.coerce.number().int().min(1).max(100),
    // Floor of one second rather than zero: "as often as possible" is not a
    // setting anybody wants once they have it, and zero would let one camera
    // saturate whatever it runs on.
    minGapSeconds: z.coerce.number().int().min(1).max(3600),
    // Zero is allowed and means "report the instant anything moves", which is
    // what somebody watching a doorway for a courier wants and what a camera
    // pointed at a hedge must never be set to.
    settleSeconds: z.coerce.number().int().min(0).max(60),
    classes: z.array(z.enum(OBJECT_CLASSES)).max(OBJECT_CLASSES.length),
    faceThreshold: z.coerce.number().int().min(1).max(100),
    hours: z
        .object({
            from: z.coerce.number().int().min(0).max(23),
            to: z.coerce.number().int().min(0).max(23)
        })
        .nullable()
});

/** Where the RTSP connection is made from: here, or a server that can see the
 *  camera when Polaris cannot. */
const reachViaSchema = z
    .string()
    .trim()
    .regex(/^(direct|server:[0-9a-f-]{36})$/i, "Choose where this camera is reached from");

export const cameraInputSchema = z.object({
    name: z.string().trim().min(1, "Give it a name").max(64),
    /** The place it is in. Checked against this install's places before it is
     *  stored - an id in a form is a request, not a fact. */
    placeId: z.string().trim().max(64).default(""),
    zone: z.string().trim().max(64).default(""),
    vendor: z.string().trim().min(1).max(32),
    address: addressSchema,
    rtspPort: portSchema.default(554),
    onvifPort: portSchema.nullable().default(null),
    /** Empty means "ask the camera over ONVIF", which is what most cameras get. */
    mainPath: z.string().trim().max(255).default(""),
    subPath: z.string().trim().max(255).default(""),
    username: z.string().trim().max(128).default(""),
    /** Absent on an edit that is not changing it - a stored password is never
     *  sent back to the browser, so an empty field means "leave it alone" rather
     *  than "clear it". */
    password: z.string().max(255).optional(),
    reachVia: reachViaSchema.default("direct"),
    detector: z.enum(DETECTORS).default("camera"),
    /**
     * The server detection runs on, when the chosen rung runs anywhere at all.
     *
     * An enrolled server's id, or the word for Polaris' own machine, which has
     * none. Checked here rather than left open, because the column behind it
     * takes uuids and nothing else: anything that is neither is a request that
     * ends as a database error in front of whoever was adding a camera.
     */
    detectorTargetId: z
        .string()
        .trim()
        .max(64)
        .refine(
            (value) => value === "" || value === LOCAL_MACHINE || UUID.test(value),
            "Choose where detection should run"
        )
        .nullable()
        .default(null),
    detection: detectionSettingsSchema,
    recording: z.enum(["off", "motion", "continuous"]).default("motion"),
    /** A storage connection id, "local", or empty for the instance default. The
     *  value is checked against what this instance actually has before it is
     *  stored - an id in a form is a request, not a destination. */
    storageTarget: z.string().trim().max(64).default(""),
    // A month at the top. Longer than that is a storage decision that should be
    // made deliberately with a bigger disk, not typed into a box.
    retentionDays: z.coerce.number().int().min(1).max(365).default(7),
    enabled: z.boolean().default(true)
});

export type CameraInput = z.infer<typeof cameraInputSchema>;

/** Validate what arrived from a form or an API call, normalizing first so the
 *  rules judge the value that will actually be stored. */
export function parseCameraInput(input: unknown): CameraInput {
    return cameraInputSchema.parse(normalizeCameraInput((input ?? {}) as Record<string, unknown>));
}

/**
 * A zone drawn on a camera.
 *
 * The points arrive from a browser as pairs already in frame-relative units,
 * because the editor cannot know what size the detector will decode and the
 * detector cannot know what size the editor drew on. They are clamped rather
 * than rejected: a polygon dragged a few pixels past the edge of the picture is
 * somebody drawing to the corner, not somebody sending a bad request.
 */
const zonePointSchema = z.tuple([
    z.coerce.number().min(-1).max(2),
    z.coerce.number().min(-1).max(2)
]);

export const cameraZoneInputSchema = z.object({
    name: z.string().trim().min(1, "Give the area a name").max(64),
    kind: z.enum(ZONE_KINDS).default("watch"),
    points: z
        .array(zonePointSchema)
        .min(MIN_ZONE_POINTS, "An area needs at least three corners")
        .max(MAX_ZONE_POINTS, "That is more corners than an area needs"),
    /** Empty means every class this camera reports. */
    objects: z.array(z.enum(OBJECT_CLASSES)).max(OBJECT_CLASSES.length).default([]),
    // One frame means "the moment the box lands in it", which is right for a
    // doorway and wrong for anything with a boundary running through open
    // ground.
    inertia: z.coerce.number().int().min(1).max(30).default(3),
    // A quarter of an hour at the top. Longer than that is not loitering, it is
    // living there.
    loiterSeconds: z.coerce.number().int().min(0).max(900).default(0),
    enabled: z.boolean().default(true)
});

export type CameraZoneInput = z.infer<typeof cameraZoneInputSchema>;

/** What a zone's editable text is put through, on both sides. Trimmed first so
 *  two areas cannot be told apart by a trailing space, which the camera-unique
 *  name constraint would then let through. */
export function normalizeZoneInput(input: unknown): Record<string, unknown> {
    const value = { ...((input ?? {}) as Record<string, unknown>) };
    if (typeof value.name === "string") value.name = value.name.trim();
    return value;
}

/** What an alert can be written about. The detection ladder's vocabulary, and
 *  nothing else: a rule names a thing a camera saw. */
export const ALERT_KINDS = [
    "motion",
    "person",
    "face",
    "vehicle",
    "animal",
    "package",
    "tamper",
    "offline"
] as const;

/**
 * An alert, as the form fills it in and as the server stores it.
 *
 * Every field is a request rather than a fact: the recipients decide who is
 * added to a private conversation and the areas are matched against what an
 * event recorded, so both are shaped here before anything is written.
 */
export const alertRuleInputSchema = z.object({
    name: z.string().trim().min(1, "Give it a name").max(80),
    /** Filled in from the switcher when the form left it out. */
    placeId: z.string().regex(UUID, "Unknown place").nullable().default(null),
    cameraId: z.string().regex(UUID, "Unknown camera").nullable().default(null),
    kinds: z
        .array(z.enum(ALERT_KINDS))
        .min(1, "Choose what it should tell you about")
        .max(ALERT_KINDS.length),
    /** One person by the name the recognizer put to them, or anybody. */
    label: z.string().trim().max(120).nullable().default(null),
    zones: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
    hours: z
        .object({
            from: z.coerce.number().int().min(0).max(23),
            to: z.coerce.number().int().min(0).max(23)
        })
        .nullable()
        .default(null),
    recipients: z.array(z.string().regex(UUID, "Unknown person")).min(1, "Choose who to tell"),
    notify: z.boolean().default(false),
    enabled: z.boolean().default(true)
});

export type AlertRuleInput = z.infer<typeof alertRuleInputSchema>;

/** What a discovery sweep is asked for: one subnet, or the one Polaris is on. */
export const discoveryInputSchema = z.object({
    /** CIDR to sweep, e.g. "192.168.1.0/24". Empty means the network Polaris
     *  itself sits on. */
    subnet: z
        .string()
        .trim()
        .max(64)
        .refine(
            (value) => value === "" || /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/.test(value),
            "Write it as 192.168.1.0/24"
        )
        .default(""),
    /** A server to sweep from, for a network Polaris cannot see itself. */
    fromServerId: z.string().trim().max(64).nullable().default(null)
});

export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
