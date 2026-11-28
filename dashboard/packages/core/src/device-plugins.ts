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
    /** The device's name as the offer shows it ("Acme Mixer 4"). */
    name: z.string().trim().min(1).max(80)
});

export type PluginClaim = z.infer<typeof pluginClaimSchema>;

/** Text a plugin shows, in English and any other language it ships ("es-ES": "..."). */
const pluginTextSchema = z.object({ "en-US": z.string().trim().min(1).max(120) }).catchall(z.string().trim().min(1).max(120));
const settingKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);
/**
 * A name for what a plugin says about its device (`deviceBusy`), so a page can
 * say it in the reader's language; `detail` is the plugin's English words.
 */
export const PLUGIN_STATUS_CODE = z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/);
/** A sentence a plugin says about its device, as long as the status `detail` it stands for. */
const pluginSentenceSchema = z.object({ "en-US": z.string().trim().min(1).max(200) }).catchall(z.string().trim().min(1).max(200));

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

/**
 * Something the client sets up on one platform for a plugin to work fully (a
 * driver, say). It is listed with the permissions when the plugin is installed
 * or updated, in the plugin's own words, and the install is the consent; the
 * client runs it and puts it back when something else undoes it. Optional and
 * additive: a client older than it drops the field and installs as before.
 */
export const pluginRequirementSchema = z.object({
    key: settingKeySchema,
    /** The line in the consent list, and the action that sets it up again. */
    label: pluginTextSchema,
    hint: pluginTextSchema.optional(),
    /** What the plugin's page says while it is not set up. */
    missing: pluginTextSchema.optional(),
    /** What the client says when it set it up again by itself. */
    restored: pluginTextSchema.optional()
});

export type PluginRequirement = z.infer<typeof pluginRequirementSchema>;

const requirementListSchema = z
    .array(pluginRequirementSchema)
    .max(8)
    .refine((list) => new Set(list.map((item) => item.key)).size === list.length, "repeated requirement");
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
    /** What each platform sets up for it (`pluginRequirementSchema`); a platform left out needs nothing. */
    requires: perPlatform(requirementListSchema).default({}),
    /**
     * A page of its own for what plain settings cannot draw, shown on its
     * Settings page in a sandboxed frame. It shows, it does not ask: every
     * control is a declared setting, drawn by Polaris (docs/device-plugins.md, Views).
     */
    view: entryPathSchema.optional(),
    /**
     * Its own status sentences in each language it ships, by status `code`, for
     * what only this plugin knows about its device. A plugin's words live in its
     * package, never in the host, so a plugin release changes nothing in Polaris
     * (docs/device-plugins.md, Status). A code it leaves out is said by the host
     * when the host knows it, else as the plugin's `detail`.
     */
    statusTexts: z
        .record(PLUGIN_STATUS_CODE, pluginSentenceSchema)
        .refine((texts) => Object.keys(texts).length <= 32, "too many status texts")
        .optional(),
    /**
     * Its grouped settings can be kept as several profiles that switch by
     * themselves (in a call, in a meeting, playing a game, an app in front) or
     * by hand, like Stream Deck's. Settings that name no group stay one for all
     * profiles. An app older than profiles ignores it and keeps one set.
     */
    profiles: z.boolean().optional()
});

export type PluginManifest = z.infer<typeof pluginManifestSchema>;

export const pluginPackageSchema = z.object({
    url: releaseUrlSchema,
    sha256: sha256Schema,
    /** Bytes of the archive, shown before installing and checked while downloading. */
    size: z.number().int().positive().max(200 * 1024 * 1024)
});

export type PluginPackage = z.infer<typeof pluginPackageSchema>;

/** One version's notes, as the store lists them under What's new. */
export const pluginReleaseSchema = z.object({
    version: versionSchema,
    notes: z.string().trim().min(1).max(2_000)
});

export type PluginRelease = z.infer<typeof pluginReleaseSchema>;

export const pluginEntrySchema = pluginManifestSchema.extend({
    packages: perPlatform(pluginPackageSchema),
    icon: releaseUrlSchema.optional(),
    /** A photograph of the hardware, 16:10, on the store's card in place of the placeholder. */
    picture: releaseUrlSchema.optional(),
    screenshots: z.array(releaseUrlSchema).max(8).default([]),
    /**
     * The old way to say what changed: every version in one string, "0.1.18: ...
     * 0.1.17: ...". Still written for the desktop apps that read only this field;
     * `pluginReleases` splits it for an entry that carries no `releases`.
     */
    changelog: z.string().max(4_000).default(""),
    /** What changed, one entry per version, newest first. Read in place of `changelog` when present. */
    releases: z.array(pluginReleaseSchema).max(50).default([]),
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
        /**
         * Read one entry at a time: an entry this build cannot read (a category,
         * permission or setting kind from a newer catalog) is left out on its own,
         * so a new plugin never hides every other one from a client that predates
         * it. The first of a repeated id is kept.
         */
        plugins: z
            .array(z.unknown())
            .max(500)
            .transform((list) => {
                const seen = new Set<string>();
                const entries: z.infer<typeof pluginEntrySchema>[] = [];
                for (const raw of list) {
                    const entry = pluginEntrySchema.safeParse(raw);
                    if (!entry.success || seen.has(entry.data.id)) continue;
                    seen.add(entry.data.id);
                    entries.push(entry.data);
                }
                return entries;
            })
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

/** What the manifest has this platform set up for it, none when it names nothing for it. */
export function pluginRequirements(manifest: Pick<PluginManifest, "requires">, platform: PluginPlatform | null): readonly PluginRequirement[] {
    return (platform ? manifest.requires[platform] : undefined) ?? [];
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

/** One version's notes as the page lists them; `version` is null for text the old string had before any version. */
export interface PluginReleaseNotes {
    readonly version: string | null;
    readonly notes: string;
}

/**
 * A version where the old changelog string starts one: at the start or after a
 * space, three numbers, an optional "v", and a colon followed by a space or the end.
 */
const CHANGELOG_MARKER = /(^|\s)v?(\d{1,4}\.\d{1,5}\.\d{1,6}):(?=\s|$)/g;

/**
 * The old one-string changelog ("0.1.18: ... 0.1.17: ...") as one entry per
 * version, newest first. Text before the first version is kept as an entry
 * without one, last; a string with no version at all is that one entry. A
 * version written twice keeps both texts, joined, under the first place it appears.
 */
export function splitPluginChangelog(text: string): PluginReleaseNotes[] {
    const marks = [...text.matchAll(CHANGELOG_MARKER)].map((match) => ({ version: match[2]!, at: match.index! + match[1]!.length, body: match.index! + match[0].length }));
    const lead = text.slice(0, marks[0]?.at ?? text.length).trim();
    const byVersion = new Map<string, string[]>();
    marks.forEach((mark, index) => {
        const notes = text.slice(mark.body, marks[index + 1]?.at ?? text.length).trim();
        if (!notes) return;
        byVersion.set(mark.version, [...(byVersion.get(mark.version) ?? []), notes]);
    });
    const versioned = [...byVersion].map(([version, notes]) => ({ version, notes: notes.join(" ") }));
    versioned.sort((a, b) => comparePluginVersions(b.version, a.version));
    return lead ? [...versioned, { version: null, notes: lead }] : versioned;
}

/** What changed in a catalog entry, one entry per version, newest first: its `releases`, else its old string split. */
export function pluginReleases(entry: { readonly releases?: readonly PluginRelease[]; readonly changelog?: string }): PluginReleaseNotes[] {
    if (entry.releases && entry.releases.length > 0) return [...entry.releases].sort((a, b) => comparePluginVersions(b.version, a.version));
    return splitPluginChangelog(entry.changelog ?? "");
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
 * What a plugin's status `code` reads as in the reader's language, from the
 * plugin's own `statusTexts`: the first of `manifests` that has it (the
 * installed version, then the catalog's newer one), or null when none does.
 */
export function pluginStatusText(manifests: readonly (Pick<PluginManifest, "statusTexts"> | null | undefined)[], code: string | undefined, locale: string): string | null {
    if (!code) return null;
    for (const manifest of manifests) {
        const text = manifest?.statusTexts?.[code];
        if (text) return pluginText(text, locale);
    }
    return null;
}

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

/**
 * Something the client offers to do for an installed plugin, drawn by the page
 * beside Uninstall and run through `plugins.runAction` (setting up a
 * requirement that is missing, say). The words are the plugin's or the client's.
 */
export const pluginHostActionSchema = z.object({
    id: settingKeySchema,
    label: pluginTextSchema,
    /** What is wrong while the action is offered. */
    detail: pluginTextSchema.optional(),
    /** What the action is about, by name (the program holding a device, say), for a page that words a known action itself. */
    subject: z.string().trim().min(1).max(100).optional()
});

export type PluginHostAction = z.infer<typeof pluginHostActionSchema>;

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
    /** What the client offers to do for it (`pluginHostActionSchema`). Absent from an older app. */
    actions: z.array(pluginHostActionSchema).max(8).default([]),
    /** Its profiles and the one in use, for a plugin with `profiles` (`pluginProfilesViewSchema`). Absent from an older app. */
    profiles: z
        .unknown()
        .optional()
        .transform((value) => {
            const parsed = pluginProfilesViewSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
        }),
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
/*
 * Profiles (manifest `profiles`): several sets of a plugin's grouped settings,
 * one of them in use at a time, the way Stream Deck and other controllers' own software
 * keep them. "Default" is the settings file every install already has, so an
 * install from before profiles keeps all it had as its Default profile; the
 * others live beside it. Which one is in use is chosen by hand, or else by the
 * first rule that matches, in this order: a Polaris call, a meeting in another
 * app (the microphone in use by it), a game running, an app in front. A new
 * automatic choice must hold for PLUGIN_PROFILE_HOLD_MS before the device
 * switches, so a moment's change does not flip it back and forth.
 */

/** The profile every plugin with profiles has: its settings as they were stored before profiles. */
export const DEFAULT_PLUGIN_PROFILE = "default";
/** The most profiles one plugin keeps besides Default. */
export const MAX_PLUGIN_PROFILES = 16;
/** How long a new automatic choice holds before the device switches to it. */
export const PLUGIN_PROFILE_HOLD_MS = 2_000;
/** Why a profile is the one in use, in the order the choice looks. */
export const PLUGIN_PROFILE_REASONS = ["manual", "call", "meeting", "game", "app", "default"] as const;
export type PluginProfileReason = (typeof PLUGIN_PROFILE_REASONS)[number];

const profileIdSchema = z.string().regex(/^[a-z0-9]{1,24}$/);
const profileNameSchema = z.string().trim().min(1).max(40);

/** A program the way a rule names it: its file name, lowercase, without ".exe" or a folder. */
export function pluginProgramKey(name: string): string {
    const base = name.trim().split(/[\\/]/).pop() ?? "";
    return base.toLowerCase().replace(/\.exe$/, "").trim();
}

const programSchema = z.string().trim().min(1).max(260).transform(pluginProgramKey).refine((key) => key.length > 0, "no program");

export const pluginProfileRulesSchema = z.object({
    /** In a Polaris call. */
    call: z.boolean().default(false),
    /** In a meeting in another app: something other than Polaris has the microphone. */
    meeting: z.boolean().default(false),
    /** A game is running. */
    game: z.boolean().default(false),
    /** One of these programs is in front (`pluginProgramKey`). */
    apps: z
        .array(programSchema)
        .max(16)
        .default([])
        .transform((list) => [...new Set(list)])
});

export type PluginProfileRules = z.infer<typeof pluginProfileRulesSchema>;

export const NO_PLUGIN_PROFILE_RULES: PluginProfileRules = { call: false, meeting: false, game: false, apps: [] };

export interface PluginProfile {
    readonly id: string;
    readonly name: string;
    readonly rules: PluginProfileRules;
    /** Its value for every grouped setting. */
    readonly values: Record<string, PluginSettingValue>;
}

/** What is stored beside the settings file: the profiles besides Default, and the one picked by hand. */
export interface PluginProfiles {
    /** A profile picked by hand (Default included), or null to choose by the rules. */
    readonly manual: string | null;
    readonly list: readonly PluginProfile[];
}

export const NO_PLUGIN_PROFILES: PluginProfiles = { manual: null, list: [] };

/** The settings a profile holds: every one in a group. The rest are one for all profiles. */
export function profiledPluginSettings(settings: readonly PluginSetting[]): PluginSetting[] {
    return settings.filter((setting) => setting.group !== undefined);
}

const storedProfileSchema = z.object({
    id: profileIdSchema.refine((id) => id !== DEFAULT_PLUGIN_PROFILE),
    name: profileNameSchema,
    rules: pluginProfileRulesSchema.catch(NO_PLUGIN_PROFILE_RULES),
    values: z.record(z.string(), z.unknown()).catch({})
});

/**
 * The stored profiles, every one whole: an entry of the wrong shape is
 * dropped, a value that no longer fits its setting falls back to its default
 * (the way `readPluginSettingValues` reads the settings file), and a hand pick
 * of a profile that is gone reads as none.
 */
export function readPluginProfiles(settings: readonly PluginSetting[], stored: unknown): PluginProfiles {
    const source = stored && typeof stored === "object" ? (stored as { manual?: unknown; list?: unknown; }) : {};
    const profiled = profiledPluginSettings(settings);
    const list: PluginProfile[] = [];
    const ids = new Set<string>();
    for (const item of Array.isArray(source.list) ? source.list : []) {
        const parsed = storedProfileSchema.safeParse(item);
        if (!parsed.success || ids.has(parsed.data.id) || list.length >= MAX_PLUGIN_PROFILES) continue;
        ids.add(parsed.data.id);
        list.push({ id: parsed.data.id, name: parsed.data.name, rules: parsed.data.rules, values: readPluginSettingValues(profiled, parsed.data.values) });
    }
    const manual = typeof source.manual === "string" && (source.manual === DEFAULT_PLUGIN_PROFILE || ids.has(source.manual)) ? source.manual : null;
    return { manual, list };
}

/** The values a plugin runs with under one profile: the settings file, with that profile's grouped values over it. */
export function pluginProfileValues(flat: Record<string, PluginSettingValue>, profiles: PluginProfiles, id: string): Record<string, PluginSettingValue> {
    const profile = profiles.list.find((item) => item.id === id);
    return profile ? { ...flat, ...profile.values } : flat;
}

/** What the app can tell right now, for the rules. */
export interface PluginProfileSignals {
    /** In a Polaris call. */
    readonly call: boolean;
    /** The program using the microphone when it is not Polaris, else null. */
    readonly meeting: string | null;
    /** The games running, by program. */
    readonly games: readonly string[];
    /** The program in front, or null when it cannot be told. */
    readonly front: string | null;
}

export interface PluginProfileChoice {
    readonly id: string;
    readonly reason: PluginProfileReason;
    /** What made the rule match (the program in a meeting, the game, the app in front), when there is one to name. */
    readonly subject: string | null;
}

/** The profile that should be in use: the hand pick, else the first rule that matches in PLUGIN_PROFILE_REASONS order, else Default. */
export function choosePluginProfile(profiles: PluginProfiles, signals: PluginProfileSignals): PluginProfileChoice {
    if (profiles.manual) return { id: profiles.manual, reason: "manual", subject: null };
    const first = (match: (rules: PluginProfileRules) => boolean) => profiles.list.find((profile) => match(profile.rules));
    if (signals.call) {
        const found = first((rules) => rules.call);
        if (found) return { id: found.id, reason: "call", subject: null };
    }
    if (signals.meeting) {
        const found = first((rules) => rules.meeting);
        if (found) return { id: found.id, reason: "meeting", subject: signals.meeting };
    }
    if (signals.games.length > 0) {
        const found = first((rules) => rules.game);
        if (found) return { id: found.id, reason: "game", subject: signals.games[0] ?? null };
    }
    const front = signals.front ? pluginProgramKey(signals.front) : "";
    if (front) {
        const found = first((rules) => rules.apps.includes(front));
        if (found) return { id: found.id, reason: "app", subject: signals.front };
    }
    return { id: DEFAULT_PLUGIN_PROFILE, reason: "default", subject: null };
}

/** The profile in use, and a choice waiting out its hold. */
export interface PluginProfileHold {
    readonly active: PluginProfileChoice | null;
    readonly pending: PluginProfileChoice | null;
    readonly since: number;
}

export const NO_PLUGIN_PROFILE_HOLD: PluginProfileHold = { active: null, pending: null, since: 0 };

/**
 * The profile in use after `wanted` was chosen at `now`. A hand pick, and
 * leaving one, switch at once (the person asked); an automatic change to
 * another profile switches only once it has been wanted for `holdMs` in a row.
 */
export function holdPluginProfile(hold: PluginProfileHold, wanted: PluginProfileChoice, now: number, holdMs = PLUGIN_PROFILE_HOLD_MS): PluginProfileHold {
    const { active } = hold;
    if (!active || active.id === wanted.id || wanted.reason === "manual" || active.reason === "manual") return { active: wanted, pending: null, since: now };
    if (hold.pending && hold.pending.id === wanted.id) {
        return now - hold.since >= holdMs ? { active: wanted, pending: null, since: now } : { active, pending: wanted, since: hold.since };
    }
    return { active, pending: wanted, since: now };
}

/** What a page may ask of a plugin's profiles. */
export const pluginProfileRequestSchema = z.discriminatedUnion("op", [
    /** A new profile: a copy of `from` (Default included), or the plugin's defaults without one. */
    z.object({ op: z.literal("create"), name: profileNameSchema, from: profileIdSchema.optional() }),
    z.object({ op: z.literal("rename"), profile: profileIdSchema, name: profileNameSchema }),
    z.object({ op: z.literal("delete"), profile: profileIdSchema }),
    z.object({ op: z.literal("rules"), profile: profileIdSchema, rules: pluginProfileRulesSchema }),
    /** Use one by hand (Default included), or null to go back to the rules. */
    z.object({ op: z.literal("pick"), profile: profileIdSchema.nullable() })
]);

export type PluginProfileRequest = z.infer<typeof pluginProfileRequestSchema>;
export type PluginProfileError = "not-found" | "name-taken" | "full" | "default";
export type PluginProfileOutcome = { readonly ok: true; readonly profiles: PluginProfiles; readonly id: string | null; } | { readonly ok: false; readonly error: PluginProfileError; };

/**
 * One request carried out on the stored profiles (pure: the caller stores the
 * answer). `flat` is the settings file, which a copy of Default starts from;
 * `newId` names a created profile.
 */
export function applyPluginProfileRequest(
    settings: readonly PluginSetting[],
    flat: Record<string, PluginSettingValue>,
    profiles: PluginProfiles,
    request: PluginProfileRequest,
    newId: () => string
): PluginProfileOutcome {
    const profiled = profiledPluginSettings(settings);
    const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
    const taken = (name: string, except: string | null) => same(name, DEFAULT_PLUGIN_PROFILE) || profiles.list.some((item) => item.id !== except && same(item.name, name));
    const known = (id: string) => profiles.list.some((item) => item.id === id);
    switch (request.op) {
        case "create": {
            if (profiles.list.length >= MAX_PLUGIN_PROFILES) return { ok: false, error: "full" };
            if (taken(request.name, null)) return { ok: false, error: "name-taken" };
            if (request.from !== undefined && request.from !== DEFAULT_PLUGIN_PROFILE && !known(request.from)) return { ok: false, error: "not-found" };
            const base = request.from === undefined ? {} : pluginProfileValues(flat, profiles, request.from);
            let id = newId();
            while (id === DEFAULT_PLUGIN_PROFILE || known(id) || !profileIdSchema.safeParse(id).success) id = newId();
            const profile: PluginProfile = { id, name: request.name, rules: NO_PLUGIN_PROFILE_RULES, values: readPluginSettingValues(profiled, base) };
            return { ok: true, profiles: { ...profiles, list: [...profiles.list, profile] }, id };
        }
        case "rename":
        case "rules":
        case "delete": {
            if (request.profile === DEFAULT_PLUGIN_PROFILE) return { ok: false, error: "default" };
            if (!known(request.profile)) return { ok: false, error: "not-found" };
            if (request.op === "delete") {
                const list = profiles.list.filter((item) => item.id !== request.profile);
                return { ok: true, profiles: { manual: profiles.manual === request.profile ? null : profiles.manual, list }, id: null };
            }
            if (request.op === "rename" && taken(request.name, request.profile)) return { ok: false, error: "name-taken" };
            const list = profiles.list.map((item) => {
                if (item.id !== request.profile) return item;
                return request.op === "rename" ? { ...item, name: request.name } : { ...item, rules: request.rules };
            });
            return { ok: true, profiles: { ...profiles, list }, id: request.profile };
        }
        case "pick": {
            if (request.profile !== null && request.profile !== DEFAULT_PLUGIN_PROFILE && !known(request.profile)) return { ok: false, error: "not-found" };
            return { ok: true, profiles: { ...profiles, manual: request.profile }, id: request.profile };
        }
    }
}

/** A plugin's profiles as its page draws them (`InstalledPlugin.profiles`). */
export const pluginProfilesViewSchema = z.object({
    list: z.array(z.object({ id: profileIdSchema, name: profileNameSchema, rules: pluginProfileRulesSchema })).max(MAX_PLUGIN_PROFILES),
    manual: profileIdSchema.nullable(),
    active: z.object({ id: profileIdSchema, reason: z.enum(PLUGIN_PROFILE_REASONS), subject: z.string().max(260).nullable() }),
    /** What this computer can tell; a rule on what it cannot tell never matches. */
    reads: z.object({ meeting: z.boolean(), front: z.boolean() })
});

export type PluginProfilesView = z.infer<typeof pluginProfilesViewSchema>;
/*
 * Custom device actions (docs/device-plugins.md, "Custom actions"): what the
 * owner of a computer assigns to a lit button or a knob press beyond the
 * call actions above, the way Stream Deck's System actions (Open, Website,
 * Hotkey), Multi Action (steps with delays) and Multi Action Switch / Hotkey
 * Switch (two states) work. They are kept by the desktop app on this
 * computer only; the page edits them through the desktop, which checks every
 * one against these schemas and asks before an action it has not run yet.
 */

/** The keys a hotkey step can press, by name; the desktop maps each to the system's key code. */
export const DEVICE_ACTION_KEYS = [
    ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
    ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`),
    "enter", "escape", "tab", "space", "backspace", "delete", "insert", "home", "end", "pageUp", "pageDown",
    "up", "down", "left", "right", "printScreen",
    "volumeUp", "volumeDown", "volumeMute", "mediaPlayPause", "mediaNext", "mediaPrevious", "mediaStop"
] as unknown as [string, ...string[]];

export const MAX_DEVICE_ACTIONS = 200;
export const MAX_DEVICE_ACTION_STEPS = 50;
/** One delay step: Stream Deck's Multi Action allows long pauses, not endless ones. */
export const MAX_DEVICE_ACTION_DELAY_MS = 10_000;
/** All the delays of one state together: a macro never holds the device for longer. */
export const MAX_DEVICE_ACTION_TOTAL_DELAY_MS = 60_000;
export const MAX_DEVICE_ACTION_ARGS = 32;

/** The prefixes an `action` setting carries for a custom action and for a launcher entry. */
export const CUSTOM_ACTION_PREFIX = "custom:";
export const LAUNCHER_ACTION_PREFIX = "launcher:";

const CONTROL = /[\u0000-\u001f\u007f]/;
const plainText = (max: number) => z.string().max(max).refine((text) => !CONTROL.test(text), "control character");

/** A full path on this computer: a drive (`C:\`), a share (`\\server\`) or a root (`/`). */
export const absolutePathSchema = plainText(1024)
    .transform((text) => text.trim())
    .refine((text) => text.length >= 2 && /^(?:[a-zA-Z]:[\\/]|\\\\[^\\]|\/)/.test(text), "not a full path");

const websiteSchema = plainText(2048)
    .transform((text) => text.trim())
    .refine((text) => {
        try {
            const url = new URL(text);
            return url.protocol === "https:" || url.protocol === "http:";
        } catch {
            return false;
        }
    }, "not a web address");

/** A launcher entry an action can run: a system command by id, or a Polaris page by path. */
export const launcherEntrySchema = z
    .string()
    .max(55)
    .regex(/^(?:system:[a-z-]{1,32}|page:\/[A-Za-z0-9/_-]{0,48})$/);

export const deviceActionStepSchema = z.discriminatedUnion("kind", [
    /** A file or folder, opened the way the system opens it. */
    z.object({ kind: z.literal("open"), path: absolutePathSchema }),
    z.object({ kind: z.literal("website"), url: websiteSchema }),
    /** A program with its arguments, each one passed as is: never a command line a shell reads. */
    z.object({ kind: z.literal("run"), file: absolutePathSchema, args: z.array(plainText(1000)).max(MAX_DEVICE_ACTION_ARGS).default([]) }),
    z.object({
        kind: z.literal("hotkey"),
        key: z.enum(DEVICE_ACTION_KEYS),
        ctrl: z.boolean().default(false),
        alt: z.boolean().default(false),
        shift: z.boolean().default(false),
        meta: z.boolean().default(false)
    }),
    z.object({ kind: z.literal("polaris"), action: z.enum(PLUGIN_ACTIONS) }),
    z.object({ kind: z.literal("launcher"), entry: launcherEntrySchema }),
    z.object({ kind: z.literal("delay"), ms: z.number().int().min(0).max(MAX_DEVICE_ACTION_DELAY_MS) })
]);

export type DeviceActionStep = z.infer<typeof deviceActionStepSchema>;

const stepsSchema = z
    .array(deviceActionStepSchema)
    .min(1)
    .max(MAX_DEVICE_ACTION_STEPS)
    .refine((steps) => steps.reduce((total, step) => total + (step.kind === "delay" ? step.ms : 0), 0) <= MAX_DEVICE_ACTION_TOTAL_DELAY_MS, "delays too long")
    .refine((steps) => steps.some((step) => step.kind !== "delay"), "only delays");

export const deviceActionIdSchema = z.string().regex(/^[a-z0-9-]{1,40}$/);

/**
 * One custom action: its steps run in order; with `off` it has two states
 * and each press runs the other one (Stream Deck's Multi Action Switch).
 */
export const deviceActionSchema = z.object({
    id: deviceActionIdSchema,
    name: plainText(60)
        .transform((text) => text.trim())
        .refine((text) => text.length > 0, "empty"),
    steps: stepsSchema,
    off: stepsSchema.optional()
});

export type DeviceAction = z.infer<typeof deviceActionSchema>;

/** What the page may ask the desktop about custom actions. */
export const deviceActionRequestSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("list") }),
    z.object({ kind: z.literal("save"), action: deviceActionSchema }),
    z.object({ kind: z.literal("remove"), id: deviceActionIdSchema }),
    /** Run it now, as a press would: the desktop still asks before a new or changed one. */
    z.object({ kind: z.literal("run"), id: deviceActionIdSchema }),
    /** The system's own picker, so a path is chosen rather than typed. */
    z.object({ kind: z.literal("pick"), what: z.enum(["file", "folder", "program"]) })
]);

export type DeviceActionRequest = z.infer<typeof deviceActionRequestSchema>;

/** What the desktop answers `list` with. */
export interface DeviceActionsView {
    readonly actions: readonly (DeviceAction & { readonly confirmed: boolean; readonly on: boolean; })[];
    /** The launcher entries an action or a button can run. */
    readonly launcher: readonly { readonly entry: string; readonly label: string; }[];
    /** Null when hotkey steps can be sent on this computer, else why not. */
    readonly hotkeys: "unsupported" | null;
}

/** What an `action` setting's value names: a call action, a custom action or a launcher entry; null when none of them. */
export function readActionRef(value: string): { kind: "call"; action: PluginAction; } | { kind: "custom"; id: string; } | { kind: "launcher"; entry: string; } | null {
    if ((PLUGIN_ACTIONS as readonly string[]).includes(value)) return { kind: "call", action: value as PluginAction };
    if (value.startsWith(CUSTOM_ACTION_PREFIX)) {
        const id = deviceActionIdSchema.safeParse(value.slice(CUSTOM_ACTION_PREFIX.length));
        return id.success ? { kind: "custom", id: id.data } : null;
    }
    if (value.startsWith(LAUNCHER_ACTION_PREFIX)) {
        const entry = launcherEntrySchema.safeParse(value.slice(LAUNCHER_ACTION_PREFIX.length));
        return entry.success ? { kind: "launcher", entry: entry.data } : null;
    }
    return null;
}

/** The ids `polaris.action` takes from a plugin: a call action, or a custom or launcher one. */
export const pluginActionRefSchema = z
    .string()
    .max(64)
    .refine((value) => readActionRef(value) !== null, "unknown action");
