/**
 * Device add-ons: pieces of a Polaris client that are installed on one device
 * - support for a piece of hardware first of all - rather than on a host.
 *
 * An add-on is described by one manifest, the same for every client that can
 * run it (the desktop app today; the phone and TV apps read the same shape).
 * The catalog of add-ons is published from the Polaris repository's releases
 * and signed there, so it is the same list on any host, signed out and offline
 * once fetched: no host serves it, and no host can change it.
 *
 * Shaped after the Stream Deck SDK manifest (one id, an entry per OS, a minimum
 * app version) and VS Code's activation events (nothing runs until it is
 * needed); here the activation is the USB device an add-on claims being
 * plugged in. The client checks the catalog's Ed25519 signature and each
 * package's SHA-256 before it unpacks anything.
 */

import { z } from "zod";

/** What an add-on may ask its client for. Nothing is granted that is not listed. */
export const ADDON_PERMISSIONS = ["usb", "audio-sessions", "display", "polaris-actions", "network"] as const;

export type AddonPermission = (typeof ADDON_PERMISSIONS)[number];

/** Where a package can run: the client's OS and CPU, as Node names them. */
export const ADDON_PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const;

export type AddonPlatform = (typeof ADDON_PLATFORMS)[number];

/** The shelves the store lists add-ons under. */
export const ADDON_CATEGORIES = ["devices", "audio", "streaming", "input", "other"] as const;

export type AddonCategory = (typeof ADDON_CATEGORIES)[number];

const versionSchema = z.string().regex(/^\d{1,4}\.\d{1,5}\.\d{1,6}$/);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
/** Packages and pictures come from the Polaris repository only, never from a host. */
const RELEASE_PREFIX = "https://github.com/FJRG2007/polaris/releases/download/";
const releaseUrlSchema = z.string().max(500).startsWith(RELEASE_PREFIX).refine((url) => !url.includes(".."), "no dot segments");
/** A path inside the package: relative, forward slashes, no way out of it. */
const entryPathSchema = z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
    .refine((path) => !path.split("/").some((part) => part === ".." || part === "."), "no dot segments");

/**
 * One value per platform, any of them left out. Spelled out rather than a
 * record keyed by the enum: zod 3 (the dashboard) and zod 4 (the desktop) read
 * an enum-keyed record differently, and this module is shared by both.
 */
function perPlatform<T extends z.ZodTypeAny>(value: T) {
    return z
        .object({
            "win32-x64": value.optional(),
            "win32-arm64": value.optional(),
            "darwin-x64": value.optional(),
            "darwin-arm64": value.optional(),
            "linux-x64": value.optional(),
            "linux-arm64": value.optional()
        })
        .strict();
}

const usbIdSchema = z.number().int().min(0).max(0xffff);

export const addonClaimSchema = z.object({
    vendorId: usbIdSchema,
    productId: usbIdSchema,
    /** The device's name as the offer shows it ("Hercules Stream 100"). */
    name: z.string().trim().min(1).max(80)
});

export type AddonClaim = z.infer<typeof addonClaimSchema>;

/** Text an add-on shows, in English and any other language it ships ("es-ES": "..."). */
const addonTextSchema = z.object({ "en-US": z.string().trim().min(1).max(120) }).catchall(z.string().trim().min(1).max(120));
const settingKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);

/**
 * One setting an add-on declares. Polaris draws it with its own controls on the
 * add-on's page in Settings, so an ordinary setting needs no add-on HTML.
 */
export const addonSettingSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("toggle"), key: settingKeySchema, label: addonTextSchema, hint: addonTextSchema.optional(), default: z.boolean() }),
    z.object({
        kind: z.literal("choice"),
        key: settingKeySchema,
        label: addonTextSchema,
        hint: addonTextSchema.optional(),
        options: z.array(z.object({ value: z.string().min(1).max(40), label: addonTextSchema })).min(1).max(32),
        default: z.string().min(1).max(40)
    }),
    z.object({
        kind: z.literal("range"),
        key: settingKeySchema,
        label: addonTextSchema,
        hint: addonTextSchema.optional(),
        min: z.number(),
        max: z.number(),
        step: z.number().positive(),
        default: z.number()
    }),
    /** A Polaris action picked from the client's own list (mute, deafen, ...), or none. */
    z.object({ kind: z.literal("action"), key: settingKeySchema, label: addonTextSchema, hint: addonTextSchema.optional(), default: z.string().max(64).nullable() })
]);

export type AddonSetting = z.infer<typeof addonSettingSchema>;
export type AddonSettingValue = boolean | string | number | null;

export const addonManifestSchema = z.object({
    schema: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
    name: z.string().trim().min(1).max(60),
    version: versionSchema,
    publisher: z.string().trim().min(1).max(60),
    summary: z.string().trim().min(1).max(140),
    category: z.enum(ADDON_CATEGORIES),
    minAppVersion: versionSchema,
    /** The module each platform starts, relative to the package root. */
    entries: perPlatform(entryPathSchema).refine((entries) => Object.values(entries).some(Boolean), "no platform"),
    /** The USB devices it drives: it sleeps while none is plugged in, and plugging one in offers it. */
    claims: z.array(addonClaimSchema).max(32).default([]),
    permissions: z
        .array(z.enum(ADDON_PERMISSIONS))
        .max(ADDON_PERMISSIONS.length)
        .default([])
        .refine((list) => new Set(list).size === list.length, "repeated permission"),
    settings: z
        .array(addonSettingSchema)
        .max(64)
        .default([])
        .refine((list) => new Set(list.map((item) => item.key)).size === list.length, "repeated setting")
        .refine((list) => list.every(settingDefaultFits), "default outside its setting"),
    /** A page of its own for what plain settings cannot draw, run in a sandboxed frame inside its Settings page. */
    view: entryPathSchema.optional()
});

export type AddonManifest = z.infer<typeof addonManifestSchema>;

export const addonPackageSchema = z.object({
    url: releaseUrlSchema,
    sha256: sha256Schema,
    /** Bytes of the archive, shown before installing and checked while downloading. */
    size: z.number().int().positive().max(200 * 1024 * 1024)
});

export type AddonPackage = z.infer<typeof addonPackageSchema>;

export const addonEntrySchema = addonManifestSchema.extend({
    packages: perPlatform(addonPackageSchema),
    icon: releaseUrlSchema.optional(),
    screenshots: z.array(releaseUrlSchema).max(8).default([]),
    changelog: z.string().max(4_000).default(""),
    published: z.string().datetime()
});

export type AddonEntry = z.infer<typeof addonEntrySchema>;

export const addonCatalogSchema = z.object({
    schema: z.literal(1),
    /** When it was signed: a client never trades the catalog it has for an older one. */
    issued: z.string().datetime(),
    addons: z
        .array(addonEntrySchema)
        .max(500)
        .refine((list) => new Set(list.map((entry) => entry.id)).size === list.length, "repeated id")
});

export type AddonCatalog = z.infer<typeof addonCatalogSchema>;

/** The largest catalog a client reads. */
export const ADDON_CATALOG_MAX_BYTES = 1024 * 1024;

export function readAddonManifest(value: unknown): AddonManifest | null {
    const parsed = addonManifestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function readAddonCatalog(value: unknown): AddonCatalog | null {
    const parsed = addonCatalogSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** `1.2.3` against `1.10.0`: negative, zero or positive. Both must be versions. */
export function compareAddonVersions(a: string, b: string): number {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** The platform name for `process.platform` and `process.arch`, or null when no add-on can run there. */
export function addonPlatform(platform: string, arch: string): AddonPlatform | null {
    const name = `${platform}-${arch}`;
    return (ADDON_PLATFORMS as readonly string[]).includes(name) ? (name as AddonPlatform) : null;
}

export type AddonFit = { readonly ok: true; readonly package: AddonPackage } | { readonly ok: false; readonly reason: "platform" | "app-version" };

/** Whether this client can install the entry, and which package it takes. */
export function addonFit(entry: AddonEntry, platform: AddonPlatform | null, appVersion: string): AddonFit {
    const pkg = platform ? entry.packages[platform] : undefined;
    if (!platform || !pkg || !entry.entries[platform]) return { ok: false, reason: "platform" };
    if (compareAddonVersions(appVersion, entry.minAppVersion) < 0) return { ok: false, reason: "app-version" };
    return { ok: true, package: pkg };
}

export interface UsbDevice {
    readonly vendorId: number;
    readonly productId: number;
}

/** Whether any of the devices is one the add-on claims. An add-on that claims none is always wanted. */
export function addonDevicePresent(manifest: Pick<AddonManifest, "claims">, devices: readonly UsbDevice[]): boolean {
    if (manifest.claims.length === 0) return true;
    return manifest.claims.some((claim) => devices.some((device) => device.vendorId === claim.vendorId && device.productId === claim.productId));
}

/** The catalog entries that claim one of the devices, each with the device it matched, for the "found" offer. */
export function addonsClaiming(catalog: AddonCatalog, devices: readonly UsbDevice[]): { entry: AddonEntry; claim: AddonClaim }[] {
    const found: { entry: AddonEntry; claim: AddonClaim }[] = [];
    for (const entry of catalog.addons) {
        const claim = entry.claims.find((c) => devices.some((d) => d.vendorId === c.vendorId && d.productId === c.productId));
        if (claim) found.push({ entry, claim });
    }
    return found;
}

function settingDefaultFits(setting: AddonSetting): boolean {
    if (setting.kind === "choice") return setting.options.some((option) => option.value === setting.default);
    if (setting.kind === "range") return setting.min < setting.max && setting.default >= setting.min && setting.default <= setting.max;
    return true;
}

function settingValue(setting: AddonSetting, value: unknown): AddonSettingValue | undefined {
    switch (setting.kind) {
        case "toggle":
            return typeof value === "boolean" ? value : undefined;
        case "choice":
            return typeof value === "string" && setting.options.some((option) => option.value === value) ? value : undefined;
        case "range":
            return typeof value === "number" && Number.isFinite(value) && value >= setting.min && value <= setting.max ? value : undefined;
        case "action":
            return value === null || (typeof value === "string" && value.length > 0 && value.length <= 64) ? value : undefined;
    }
}

/**
 * The add-on's settings as stored, every one present: a stored value that no
 * longer fits its setting (an update changed the choices) falls back to the
 * default, and keys the add-on no longer declares are dropped.
 */
export function readAddonSettingValues(settings: readonly AddonSetting[], stored: unknown): Record<string, AddonSettingValue> {
    const source = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const values: Record<string, AddonSettingValue> = {};
    for (const setting of settings) values[setting.key] = settingValue(setting, Object.hasOwn(source, setting.key) ? source[setting.key] : undefined) ?? setting.default;
    return values;
}

/** One change to one setting, or null when the key is unknown or the value does not fit it. */
export function readAddonSettingChange(settings: readonly AddonSetting[], key: unknown, value: unknown): { key: string; value: AddonSettingValue } | null {
    const setting = settings.find((item) => item.key === key);
    if (!setting) return null;
    const fitted = settingValue(setting, value);
    return fitted === undefined ? null : { key: setting.key, value: fitted };
}
