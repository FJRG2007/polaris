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
import { DETECTORS, OBJECT_CLASSES } from "@/lib/home/detection";

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

/** A host or address, once normalized. Deliberately permissive about shape - a
 *  camera can be at an IP, a hostname, or a name only the local network knows -
 *  and strict about what cannot be in one. */
const addressSchema = z
    .string()
    .trim()
    .min(1, "Where is the camera?")
    .max(255)
    .refine((value) => !/[\s@/\\]/.test(value), "Just the address: no slashes, spaces or credentials");

const portSchema = z.coerce.number().int().min(1).max(65535);

export const detectionSettingsSchema = z.object({
    sensitivity: z.coerce.number().int().min(1).max(100),
    // Floor of one second rather than zero: "as often as possible" is not a
    // setting anybody wants once they have it, and zero would let one camera
    // saturate whatever it runs on.
    minGapSeconds: z.coerce.number().int().min(1).max(3600),
    classes: z.array(z.enum(OBJECT_CLASSES)).max(OBJECT_CLASSES.length),
    faceThreshold: z.coerce.number().int().min(1).max(100),
    hours: z
        .object({ from: z.coerce.number().int().min(0).max(23), to: z.coerce.number().int().min(0).max(23) })
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
    /** The server detection runs on, when the chosen rung runs anywhere at all. */
    detectorTargetId: z.string().trim().max(64).nullable().default(null),
    detection: detectionSettingsSchema,
    recording: z.enum(["off", "motion", "continuous"]).default("off"),
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
