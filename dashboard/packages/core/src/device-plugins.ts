/**
 * Device plugins: pieces of a Polaris client that are installed on one device
 * - support for a piece of hardware first of all - rather than on a host.
 *
 * A plugin is described by one manifest, the same for every client that can
 * run it (the desktop app today; the phone and TV apps read the same shape).
 * The catalog of plugins is published from the Polaris repository's releases
 * and signed there, so it is the same list on any host, signed out and offline
 * once fetched: no host serves it, and no host can change it.
 *
 * Shaped after the Stream Deck SDK manifest (one id, an entry per OS, a minimum
 * app version) and VS Code's activation events (nothing runs until it is
 * needed); here the activation is the USB device a plugin claims being
 * plugged in. The client checks the catalog's Ed25519 signature and each
 * package's SHA-256 before it unpacks anything.
 */

import { z } from "zod";

/** What a plugin may ask its client for. Nothing is granted that is not listed. */
export const PLUGIN_PERMISSIONS = ["usb", "audio-sessions", "display", "polaris-actions", "network"] as const;

export type PluginPermission = (typeof PLUGIN_PERMISSIONS)[number];

/** Where a package can run: the client's OS and CPU, as Node names them. */
export const PLUGIN_PLATFORMS = ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"] as const;

export type PluginPlatform = (typeof PLUGIN_PLATFORMS)[number];

/** The shelves the store lists plugins under. */
export const PLUGIN_CATEGORIES = ["devices", "audio", "streaming", "input", "other"] as const;

export type PluginCategory = (typeof PLUGIN_CATEGORIES)[number];

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

export const pluginClaimSchema = z.object({
    vendorId: usbIdSchema,
    productId: usbIdSchema,
    /** The device's name as the offer shows it ("Hercules Stream 100"). */
    name: z.string().trim().min(1).max(80)
});

export type PluginClaim = z.infer<typeof pluginClaimSchema>;

/** Text a plugin shows, in English and any other language it ships ("es-ES": "..."). */
const pluginTextSchema = z.object({ "en-US": z.string().trim().min(1).max(120) }).catchall(z.string().trim().min(1).max(120));
const settingKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);

/**
 * One setting a plugin declares. Polaris draws it with its own controls on the
 * plugin's page in Settings, so an ordinary setting needs no plugin HTML.
 */
export const pluginSettingSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("toggle"), key: settingKeySchema, label: pluginTextSchema, hint: pluginTextSchema.optional(), group: settingKeySchema.optional(), default: z.boolean() }),
    z.object({
        kind: z.literal("choice"),
        key: settingKeySchema,
        label: pluginTextSchema,
        hint: pluginTextSchema.optional(),
        group: settingKeySchema.optional(),
        options: z.array(z.object({ value: z.string().min(1).max(40), label: pluginTextSchema })).min(1).max(32),
        default: z.string().min(1).max(40)
    }),
    z.object({
        kind: z.literal("range"),
        key: settingKeySchema,
        label: pluginTextSchema,
        hint: pluginTextSchema.optional(),
        group: settingKeySchema.optional(),
        min: z.number(),
        max: z.number(),
        step: z.number().positive(),
        default: z.number()
    }),
    /** A Polaris action picked from the client's own list (mute, deafen, ...), or none. */
    z.object({ kind: z.literal("action"), key: settingKeySchema, label: pluginTextSchema, hint: pluginTextSchema.optional(), group: settingKeySchema.optional(), default: z.string().max(64).nullable() })
]);

export type PluginSetting = z.infer<typeof pluginSettingSchema>;

/** How the host lays out a group of settings: one row each, or tiles in the device's own order (knobs, buttons). */
export const PLUGIN_GROUP_LOOKS = ["rows", "dials", "buttons"] as const;

/**
 * A titled section of settings on the plugin's page. Every control in it is
 * still Polaris's own; the look only chooses rows or tiles with the device's
 * shape drawn above each, so a controller's knobs read as knobs.
 */
export const pluginSettingGroupSchema = z.object({
    key: settingKeySchema,
    label: pluginTextSchema,
    hint: pluginTextSchema.optional(),
    look: z.enum(PLUGIN_GROUP_LOOKS).default("rows")
});

export type PluginSettingGroup = z.infer<typeof pluginSettingGroupSchema>;
export type PluginSettingValue = boolean | string | number | null;

export const pluginManifestSchema = z.object({
    schema: z.literal(1),
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
    name: z.string().trim().min(1).max(60),
    version: versionSchema,
    publisher: z.string().trim().min(1).max(60),
    summary: z.string().trim().min(1).max(140),
    category: z.enum(PLUGIN_CATEGORIES),
    minAppVersion: versionSchema,
    /** The module each platform starts, relative to the package root. */
    entries: perPlatform(entryPathSchema).refine((entries) => Object.values(entries).some(Boolean), "no platform"),
    /** The USB devices it drives: it sleeps while none is plugged in, and plugging one in offers it. */
    claims: z.array(pluginClaimSchema).max(32).default([]),
    permissions: z
        .array(z.enum(PLUGIN_PERMISSIONS))
        .max(PLUGIN_PERMISSIONS.length)
        .default([])
        .refine((list) => new Set(list).size === list.length, "repeated permission"),
    settings: z
        .array(pluginSettingSchema)
        .max(64)
        .default([])
        .refine((list) => new Set(list.map((item) => item.key)).size === list.length, "repeated setting")
        .refine((list) => list.every(settingDefaultFits), "default outside its setting"),
    /** Sections the settings are drawn in, in this order after the settings that name none (or a group not listed here). */
    groups: z
        .array(pluginSettingGroupSchema)
        .max(16)
        .default([])
        .refine((list) => new Set(list.map((item) => item.key)).size === list.length, "repeated group"),
    /**
     * A page of its own for what plain settings cannot draw, shown on its
     * Settings page in a sandboxed frame. It shows, it does not ask: every
     * control is a declared setting, drawn by Polaris (docs/device-plugins.md, Views).
     */
    view: entryPathSchema.optional()
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginPackageSchema = z.object({
    url: releaseUrlSchema,
    sha256: sha256Schema,
    /** Bytes of the archive, shown before installing and checked while downloading. */
    size: z.number().int().positive().max(200 * 1024 * 1024)
});

export type PluginPackage = z.infer<typeof pluginPackageSchema>;

export const pluginEntrySchema = pluginManifestSchema.extend({
    packages: perPlatform(pluginPackageSchema),
    icon: releaseUrlSchema.optional(),
    /** A photograph of the hardware, 16:10, on the store's card in place of the placeholder. */
    picture: releaseUrlSchema.optional(),
    screenshots: z.array(releaseUrlSchema).max(8).default([]),
    changelog: z.string().max(4_000).default(""),
    published: z.string().datetime()
});

export type PluginEntry = z.infer<typeof pluginEntrySchema>;

/**
 * A catalog signed before the rename lists its entries under `addons`; one signed
 * after it lists them under both names, so the apps that predate it keep reading it.
 * Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
const legacyCatalogFields = (value: unknown): unknown =>
    value !== null && typeof value === "object" && !("plugins" in value) && "addons" in value ? { ...value, plugins: value.addons } : value;

export const pluginCatalogSchema = z.preprocess(
    legacyCatalogFields,
    z.object({
        schema: z.literal(1),
        /** When it was signed: a client never trades the catalog it has for an older one. */
        issued: z.string().datetime(),
        plugins: z
            .array(pluginEntrySchema)
            .max(500)
            .refine((list) => new Set(list.map((entry) => entry.id)).size === list.length, "repeated id")
    })
);

export type PluginCatalog = z.infer<typeof pluginCatalogSchema>;


/**
 * Where the signed catalog is published - the Polaris repository's
 * `device-plugins` release, the same for every host - and its signature beside
 * it (`<url>.sig`).
 */
export const PLUGIN_CATALOG_URL = "https://github.com/FJRG2007/polaris/releases/download/device-plugins/catalog.json";

/**
 * The address from before plugins were renamed (the `device-addons` release).
 * Desktop apps from before the rename read only this one, so CI publishes the
 * same signed catalog there too, and a client falls back to it when the new
 * address cannot be had. Removable once no supported desktop app or host predates the rename (desktop 0.1.124).
 */
export const LEGACY_PLUGIN_CATALOG_URL = "https://github.com/FJRG2007/polaris/releases/download/device-addons/catalog.json";

/**
 * The public halves of the keys the catalog may be signed with (raw Ed25519,
 * hex). Several may be trusted at once, so a key is replaced by shipping its
 * successor before the catalog moves to it. The desktop app and the dashboard
 * read the same list.
 */
export const PLUGIN_CATALOG_KEYS: readonly { readonly id: string; readonly publicKey: string }[] = [
    { id: "addons-2026-11", publicKey: "20ace90f4e0160264f6a05faeabe54478953849fb442ecd0708e850a4c5a846e" }
];

/** The largest catalog a client reads. */
export const PLUGIN_CATALOG_MAX_BYTES = 1024 * 1024;

export function readPluginManifest(value: unknown): PluginManifest | null {
    const parsed = pluginManifestSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

export function readPluginCatalog(value: unknown): PluginCatalog | null {
    const parsed = pluginCatalogSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** `1.2.3` against `1.10.0`: negative, zero or positive. Both must be versions. */
export function comparePluginVersions(a: string, b: string): number {
    const left = a.split(".").map(Number);
    const right = b.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** The platform name for `process.platform` and `process.arch`, or null when no plugin can run there. */
export function pluginPlatform(platform: string, arch: string): PluginPlatform | null {
    const name = `${platform}-${arch}`;
    return (PLUGIN_PLATFORMS as readonly string[]).includes(name) ? (name as PluginPlatform) : null;
}

export type PluginFit = { readonly ok: true; readonly package: PluginPackage } | { readonly ok: false; readonly reason: "platform" | "app-version" };

/** Whether this client can install the entry, and which package it takes. */
export function pluginFit(entry: PluginEntry, platform: PluginPlatform | null, appVersion: string): PluginFit {
    const pkg = platform ? entry.packages[platform] : undefined;
    if (!platform || !pkg || !entry.entries[platform]) return { ok: false, reason: "platform" };
    if (comparePluginVersions(appVersion, entry.minAppVersion) < 0) return { ok: false, reason: "app-version" };
    return { ok: true, package: pkg };
}

export interface UsbDevice {
    readonly vendorId: number;
    readonly productId: number;
}

/** Whether any of the devices is one the plugin claims. A plugin that claims none is always wanted. */
export function pluginDevicePresent(manifest: Pick<PluginManifest, "claims">, devices: readonly UsbDevice[]): boolean {
    if (manifest.claims.length === 0) return true;
    return manifest.claims.some((claim) => devices.some((device) => device.vendorId === claim.vendorId && device.productId === claim.productId));
}

/** The catalog entries that claim one of the devices, each with the device it matched, for the "found" offer. */
export function pluginsClaiming(catalog: PluginCatalog, devices: readonly UsbDevice[]): { entry: PluginEntry; claim: PluginClaim }[] {
    const found: { entry: PluginEntry; claim: PluginClaim }[] = [];
    for (const entry of catalog.plugins) {
        const claim = entry.claims.find((c) => devices.some((d) => d.vendorId === c.vendorId && d.productId === c.productId));
        if (claim) found.push({ entry, claim });
    }
    return found;
}

function settingDefaultFits(setting: PluginSetting): boolean {
    if (setting.kind === "choice") return setting.options.some((option) => option.value === setting.default);
    if (setting.kind === "range") return setting.min < setting.max && setting.default >= setting.min && setting.default <= setting.max;
    return true;
}

function settingValue(setting: PluginSetting, value: unknown): PluginSettingValue | undefined {
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
 * The plugin's settings as stored, every one present: a stored value that no
 * longer fits its setting (an update changed the choices) falls back to the
 * default, and keys the plugin no longer declares are dropped.
 */
export function readPluginSettingValues(settings: readonly PluginSetting[], stored: unknown): Record<string, PluginSettingValue> {
    const source = stored && typeof stored === "object" ? (stored as Record<string, unknown>) : {};
    const values: Record<string, PluginSettingValue> = {};
    // `??` would read a button stored as "nothing" (null) as its default; only a missing or unfit value falls back.
    for (const setting of settings) {
        const value = settingValue(setting, Object.hasOwn(source, setting.key) ? source[setting.key] : undefined);
        values[setting.key] = value === undefined ? setting.default : value;
    }
    return values;
}

/** One change to one setting, or null when the key is unknown or the value does not fit it. */
export function readPluginSettingChange(settings: readonly PluginSetting[], key: unknown, value: unknown): { key: string; value: PluginSettingValue } | null {
    const setting = settings.find((item) => item.key === key);
    if (!setting) return null;
    const fitted = settingValue(setting, value);
    return fitted === undefined ? null : { key: setting.key, value: fitted };
}

/**
 * The client actions a plugin may run and an `action` setting may pick: the
 * Polaris deck's own ids, so a device's buttons do what a deck key does.
 * Recording and the soundboard are left out: the deck asks the server whether
 * the person may record, and a sound needs a clip chosen, neither of which a
 * device button can carry. `call.leave` is the first name `call.hangup` had.
 */
export const PLUGIN_ACTIONS = ["call.mic", "call.deafen", "call.camera", "call.share", "call.hangup", "call.leave"] as const;

export type PluginAction = (typeof PLUGIN_ACTIONS)[number];

/** A plugin's text in the reader's language, English when it ships none. */
export function pluginText(text: { readonly "en-US": string; readonly [locale: string]: string }, locale: string): string {
    return text[locale] ?? text[locale.split("-")[0] ?? ""] ?? text["en-US"];
}

/**
 * A name for what a plugin says about its device (`herculesDriver`), so a page
 * can say it in the reader's language; `detail` is the plugin's English words.
 */
export const PLUGIN_STATUS_CODE = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);

const pluginStatusSchema = z.object({ state: z.enum(["connected", "sleeping", "busy", "error"]), detail: z.string().max(200).optional(), code: PLUGIN_STATUS_CODE.optional() });

/** How an installed plugin runs: its process, or why there is none. */
const pluginRunSchema = z.union([
    z.object({
        state: z.enum(["starting", "running", "restarting", "failed"]),
        crashes: z.number().int().nonnegative(),
        status: pluginStatusSchema.nullable()
    }),
    z.object({ state: z.enum(["disabled", "sleeping", "missing"]) })
]);

const installedPluginSchema = z.object({
    id: z.string().regex(/^[a-z][a-z0-9-]{1,47}$/),
    version: versionSchema,
    enabled: z.boolean(),
    granted: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length),
    /** Null when its files are gone or no longer read. */
    manifest: z.unknown().transform((value) => readPluginManifest(value)),
    update: versionSchema.nullable(),
    /** Its own automatic-update choice; null follows the snapshot's `autoUpdate`. Absent from an older app. */
    autoUpdate: z.boolean().nullable().default(null),
    /** What `update` asks for that was not accepted: it waits for the person while any is listed. */
    consent: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).default([]),
    /** A version that failed on this computer and was rolled back from. */
    failed: versionSchema.nullable().default(null),
    run: pluginRunSchema
});

/** What a desktop app answers for its plugins (`polarisDesktop.plugins.get()`). */
export const pluginsSnapshotSchema = z.object({
    platform: z.enum(PLUGIN_PLATFORMS).nullable(),
    appVersion: z.string().max(40),
    /** Null until a signed catalog was fetched once; a broken one reads as none. */
    catalog: z.unknown().transform((value) => (value === null ? null : readPluginCatalog(value))),
    /** Whether updates go in by themselves; an app older than the setting says nothing and puts none in. */
    autoUpdate: z.boolean().nullable().default(null),
    installed: z.array(installedPluginSchema).max(500),
    installing: z.record(z.string(), z.object({ received: z.number().nonnegative(), total: z.number().nonnegative() }))
});

export type PluginsSnapshot = z.infer<typeof pluginsSnapshotSchema>;
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

export function readPluginsSnapshot(value: unknown): PluginsSnapshot | null {
    const parsed = pluginsSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** What an install answers: done, or the reason it was not. */
export const pluginInstallResultSchema = z.union([
    /** `started` is false when the plugin went in but could not be started; absent from an app older than 0.1.97. */
    z.object({ ok: z.literal(true), started: z.boolean().optional() }),
    z.object({ ok: z.literal(false), reason: z.string().max(40) })
]);

/**
 * The settings as the host draws them: those in no listed group first, then
 * each group in its declared order. A group no setting names is left out.
 */
export function pluginSettingSections(manifest: Pick<PluginManifest, "settings" | "groups">): { group: PluginSettingGroup | null; settings: PluginSetting[] }[] {
    const groups = manifest.groups ?? [];
    const known = new Set(groups.map((group) => group.key));
    const loose = manifest.settings.filter((setting) => !setting.group || !known.has(setting.group));
    const sections: { group: PluginSettingGroup | null; settings: PluginSetting[] }[] = loose.length > 0 ? [{ group: null, settings: loose }] : [];
    for (const group of groups) {
        const settings = manifest.settings.filter((setting) => setting.group === group.key);
        if (settings.length > 0) sections.push({ group, settings });
    }
    return sections;
}

/** Where one setting is drawn on its plugin's page (the element's `id`), for a link straight to it. */
export function pluginSettingAnchor(key: string): string {
    return `setting-${key}`;
}

/** Where one group of settings is drawn on its plugin's page (the section's `id`). */
export function pluginGroupAnchor(key: string): string {
    return `group-${key}`;
}

/** A place on a plugin's page a search result can lead to: a group of settings or one setting. */
export interface PluginSettingTarget {
    readonly kind: "group" | "setting";
    readonly key: string;
    /** The element's `id` on the plugin's page. */
    readonly anchor: string;
    readonly label: string;
    /** The group a setting is drawn in, or null for a group and for a setting in none. */
    readonly section: string | null;
    /** Other words that find it: its hint, a choice's options, a group's settings. */
    readonly words: readonly string[];
}

/** Every group and setting of a plugin, in the order its page draws them, in the reader's language. */
export function pluginSettingTargets(manifest: Pick<PluginManifest, "settings" | "groups">, locale: string): PluginSettingTarget[] {
    const targets: PluginSettingTarget[] = [];
    for (const { group, settings } of pluginSettingSections(manifest)) {
        const section = group ? pluginText(group.label, locale) : null;
        const labels = settings.map((setting) => pluginText(setting.label, locale));
        if (group && section) {
            const words = [...(group.hint ? [pluginText(group.hint, locale)] : []), ...labels];
            targets.push({ kind: "group", key: group.key, anchor: pluginGroupAnchor(group.key), label: section, section: null, words });
        }
        settings.forEach((setting, index) => {
            const options = setting.kind === "choice" ? setting.options.map((option) => pluginText(option.label, locale)) : [];
            const words = [...(setting.hint ? [pluginText(setting.hint, locale)] : []), ...options];
            targets.push({ kind: "setting", key: setting.key, anchor: pluginSettingAnchor(setting.key), label: labels[index]!, section, words });
        });
    }
    return targets;
}
