/**
 * The settings an installed Polaris app keeps on the device itself - the
 * desktop app today - described once for every screen that draws them.
 *
 * The app owns the values and their storage (`clients/desktop/src/main/settings.ts`);
 * this is only what a screen needs to draw them: the key, its kind, the value
 * the app uses when nothing was chosen, and the category it is listed under.
 * The dashboard's Settings draws its "This app" group from it, reading and
 * writing through the app's bridge, and the desktop test suite holds the app's
 * own defaults and choices to it, so the two cannot drift apart.
 *
 * Labels are not here: the dashboard reads `appSettings.items.<key>` from its
 * catalogs, in the reader's language.
 */

import { z } from "zod";

/** The categories of the group, in the order they are listed. */
export const APP_SETTING_CATEGORIES = [
    "general",
    "window",
    "search",
    "clipboard",
    "voice",
    "hosts",
    "advanced"
] as const;

export type AppSettingCategory = (typeof APP_SETTING_CATEGORIES)[number];

/** Where a web search from the launcher goes, the first the default. */
export const APP_SEARCH_ENGINES = ["google", "duckduckgo", "bing", "brave", "startpage"] as const;

/** How long the clipboard history keeps a copy. */
export const APP_CLIPBOARD_KEEPS = ["day", "week", "month", "quarter"] as const;

/** How the voice widget looks: its faces, when names and people show, how see-through it is, and where it starts. */
export const APP_WIDGET_AVATARS = ["large", "small"] as const;
export const APP_WIDGET_NAMES = ["always", "speaking", "never"] as const;
export const APP_WIDGET_PEOPLE = ["always", "speaking"] as const;
/** Percentages, kept as text so every choice crosses the bridge the same way. */
export const APP_WIDGET_OPACITIES = ["100", "80", "60", "40"] as const;
export const APP_WIDGET_CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
/** "Max users displayed": a whole number up to this, where 0 is Off (everybody). */
export const APP_WIDGET_MAX_USERS = 25;
/** The marks under that slider, as Discord draws them. */
export const APP_WIDGET_MAX_USERS_MARKS = [0, 5, 10, 15, 20, 25] as const;

interface SettingBase<K extends string> {
    readonly key: K;
    readonly category: AppSettingCategory;
    /** Shown under another switch and only while that one is on. */
    readonly dependsOn?: string;
    /** Takes effect once the app starts again. */
    readonly restart?: boolean;
    /** Shown only by an app that lists this in its snapshot's `features`: an
     *  older app would refuse the change, or treat it as another setting's. */
    readonly feature?: AppSettingFeature;
}

/**
 * What an app newer than the first settings page can do, each named in its
 * snapshot so a page drawn by a newer Polaris never offers an older app a
 * setting it does not have.
 */
export const APP_SETTING_FEATURES = ["overlayPin", "overlayLockKey", "overlayGames"] as const;

export type AppSettingFeature = (typeof APP_SETTING_FEATURES)[number];

export type AppSettingEntry =
    | (SettingBase<string> & { readonly kind: "toggle"; readonly default: boolean })
    | (SettingBase<string> & { readonly kind: "choice"; readonly options: readonly string[]; readonly default: string })
    | (SettingBase<string> & { readonly kind: "shortcut"; readonly default: string })
    | (SettingBase<string> & {
          readonly kind: "range";
          readonly min: number;
          readonly max: number;
          readonly step: number;
          readonly marks: readonly number[];
          readonly default: number;
      });

/** Every setting, in the order each category lists them. */
export const APP_SETTINGS = [
    { key: "openAtLogin", kind: "toggle", category: "general", default: true },
    { key: "startMinimized", kind: "toggle", category: "general", default: true, dependsOn: "openAtLogin" },
    { key: "minimizeToTray", kind: "toggle", category: "window", default: true },
    { key: "launcher", kind: "toggle", category: "search", default: true },
    { key: "launcherBinding", kind: "shortcut", category: "search", default: "Alt+Space", dependsOn: "launcher" },
    { key: "launcherGameMode", kind: "toggle", category: "search", default: true, dependsOn: "launcher" },
    { key: "launcherEngine", kind: "choice", category: "search", default: "google", options: APP_SEARCH_ENGINES },
    { key: "launcherClipboard", kind: "toggle", category: "clipboard", default: true },
    {
        key: "launcherClipboardKeep",
        kind: "choice",
        category: "clipboard",
        default: "week",
        options: APP_CLIPBOARD_KEEPS,
        dependsOn: "launcherClipboard"
    },
    { key: "voiceWidget", kind: "toggle", category: "voice", default: true },
    { key: "voiceWidgetGameOnly", kind: "toggle", category: "voice", default: false, dependsOn: "voiceWidget" },
    { key: "overlayQuickActions", kind: "toggle", category: "voice", default: true, dependsOn: "voiceWidget" },
    { key: "overlayClickable", kind: "toggle", category: "voice", default: false, dependsOn: "overlayQuickActions" },
    {
        key: "voiceWidgetPinned",
        kind: "toggle",
        category: "voice",
        default: true,
        dependsOn: "voiceWidget",
        feature: "overlayPin"
    },
    {
        key: "overlayLockBinding",
        kind: "shortcut",
        category: "voice",
        default: "",
        dependsOn: "voiceWidget",
        feature: "overlayLockKey"
    },
    {
        key: "voiceWidgetAvatars",
        kind: "choice",
        category: "voice",
        default: "large",
        options: APP_WIDGET_AVATARS,
        dependsOn: "voiceWidget"
    },
    {
        key: "voiceWidgetNames",
        kind: "choice",
        category: "voice",
        default: "always",
        options: APP_WIDGET_NAMES,
        dependsOn: "voiceWidget"
    },
    {
        key: "voiceWidgetPeople",
        kind: "choice",
        category: "voice",
        default: "always",
        options: APP_WIDGET_PEOPLE,
        dependsOn: "voiceWidget"
    },
    {
        key: "voiceWidgetMaxUsers",
        kind: "range",
        category: "voice",
        default: 8,
        min: 0,
        max: APP_WIDGET_MAX_USERS,
        step: 1,
        marks: APP_WIDGET_MAX_USERS_MARKS,
        dependsOn: "voiceWidget"
    },
    {
        key: "voiceWidgetOpacity",
        kind: "choice",
        category: "voice",
        default: "100",
        options: APP_WIDGET_OPACITIES,
        dependsOn: "voiceWidget"
    },
    {
        key: "voiceWidgetCorner",
        kind: "choice",
        category: "voice",
        default: "top-left",
        options: APP_WIDGET_CORNERS,
        dependsOn: "voiceWidget"
    },
    { key: "hardwareAcceleration", kind: "toggle", category: "advanced", default: true, restart: true }
] as const satisfies readonly AppSettingEntry[];

export type AppSettingKey = (typeof APP_SETTINGS)[number]["key"];

/** The switches, which the app sets with one call each (the toggles of `APP_SETTINGS`). */
export const APP_SETTING_TOGGLES = [
    "openAtLogin",
    "startMinimized",
    "minimizeToTray",
    "launcher",
    "launcherGameMode",
    "launcherClipboard",
    "voiceWidget",
    "voiceWidgetGameOnly",
    "overlayQuickActions",
    "overlayClickable",
    "voiceWidgetPinned",
    "hardwareAcceleration"
] as const;

/** The settings of one category, in order. */
export function appSettingsIn(category: AppSettingCategory): readonly AppSettingEntry[] {
    return APP_SETTINGS.filter((entry) => entry.category === category);
}

/** A category named in an address, or null for one that does not exist. */
export function readAppSettingCategory(raw: unknown): AppSettingCategory | null {
    const parsed = z.enum(APP_SETTING_CATEGORIES).safeParse(raw);
    return parsed.success ? parsed.data : null;
}

const savedHostSchema = z.object({
    origin: z.string().max(2048),
    name: z.string().max(200).nullable().catch(null)
});

/** A game the overlay can be turned off for, by the program that runs it. */
const overlayGameSchema = z.object({
    key: z.string().min(1).max(260),
    name: z.string().max(120),
    on: z.boolean(),
    /** Running now. */
    running: z.boolean().catch(false)
});

export type AppOverlayGame = z.infer<typeof overlayGameSchema>;

/** Turning the overlay on or off for one game, as a screen asks for it. */
export const appOverlayGameChangeSchema = z
    .object({ key: z.string().min(1).max(260), on: z.boolean() })
    .strict();

export type AppOverlayGameChange = z.infer<typeof appOverlayGameChangeSchema>;

/** Whether a setting is offered with this app: one that needs a feature only when the app has it. */
export function appSettingOffered(entry: AppSettingEntry, features: readonly AppSettingFeature[]): boolean {
    return !entry.feature || features.includes(entry.feature);
}

/**
 * What the app answers when asked for its settings: every value, plus the
 * facts about this device a screen says beside them. Read through a schema
 * because it crosses from another program, which may be an older or newer
 * build: a value it does not send falls back to the default the app uses.
 */
const snapshotSchema = z.object({
    openAtLogin: z.boolean().catch(true),
    startMinimized: z.boolean().catch(true),
    minimizeToTray: z.boolean().catch(true),
    launcher: z.boolean().catch(true),
    launcherBinding: z.string().max(40).catch("Alt+Space"),
    launcherGameMode: z.boolean().catch(true),
    launcherEngine: z.enum(APP_SEARCH_ENGINES).catch("google"),
    launcherClipboard: z.boolean().catch(true),
    launcherClipboardKeep: z.enum(APP_CLIPBOARD_KEEPS).catch("week"),
    voiceWidget: z.boolean().catch(true),
    voiceWidgetGameOnly: z.boolean().catch(false),
    voiceWidgetAvatars: z.enum(APP_WIDGET_AVATARS).catch("large"),
    voiceWidgetNames: z.enum(APP_WIDGET_NAMES).catch("always"),
    voiceWidgetPeople: z.enum(APP_WIDGET_PEOPLE).catch("always"),
    voiceWidgetOpacity: z.enum(APP_WIDGET_OPACITIES).catch("100"),
    voiceWidgetCorner: z.enum(APP_WIDGET_CORNERS).catch("top-left"),
    voiceWidgetMaxUsers: z.number().int().min(0).max(APP_WIDGET_MAX_USERS).catch(8),
    overlayQuickActions: z.boolean().catch(true),
    overlayClickable: z.boolean().catch(false),
    voiceWidgetPinned: z.boolean().catch(true),
    /** The overlay's lock key as chosen, in the dashboard's spelling; empty for the default keys. */
    overlayLockBinding: z.string().max(40).catch(""),
    /** The overlay's lock key as a person reads it, and what stops it when it is not held. */
    overlayLockKey: z.string().max(60).nullable().catch(null),
    overlayLockProblem: z.string().max(500).nullable().catch(null),
    /** The game running now and each one the overlay was turned off for, with whether it shows there. */
    overlayGames: z.array(overlayGameSchema).max(200).catch([]),
    /** What this app can do beyond the first settings page (`APP_SETTING_FEATURES`); unknown names are dropped. */
    features: z
        .array(z.string().max(32))
        .max(32)
        .catch([])
        .transform((names) => APP_SETTING_FEATURES.filter((feature) => names.includes(feature))),
    hardwareAcceleration: z.boolean().catch(true),
    /** The kept choice differs from the one this run started with. */
    restartPending: z.boolean().catch(false),
    /** The clipboard history outlives a restart (the system has a key store). */
    launcherClipboardPersists: z.boolean().catch(true),
    /** The launcher's key as a person reads it, and what stops it when it is not held. */
    launcherKey: z.string().max(60).catch("Alt+Space"),
    launcherProblem: z.string().max(500).nullable().catch(null),
    version: z.string().max(64).catch(""),
    /** The host this app opens, and every one it knows; changed only from the app's own page. */
    server: z.string().max(2048).nullable().catch(null),
    servers: z.array(savedHostSchema).max(200).catch([])
});

export type AppSettingsSnapshot = z.infer<typeof snapshotSchema>;

/** The app's answer as a snapshot, or null for one that is not an object at all. */
export function readAppSettings(raw: unknown): AppSettingsSnapshot | null {
    if (!raw || typeof raw !== "object") return null;
    const parsed = snapshotSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** One change a screen asks for: a key and a value of that key's kind and choices. */
export const appSettingChangeSchema = z.union([
    z.object({ key: z.enum(APP_SETTING_TOGGLES), value: z.boolean() }).strict(),
    z.object({ key: z.literal("launcherEngine"), value: z.enum(APP_SEARCH_ENGINES) }).strict(),
    z.object({ key: z.literal("launcherClipboardKeep"), value: z.enum(APP_CLIPBOARD_KEEPS) }).strict(),
    z.object({ key: z.literal("voiceWidgetAvatars"), value: z.enum(APP_WIDGET_AVATARS) }).strict(),
    z.object({ key: z.literal("voiceWidgetNames"), value: z.enum(APP_WIDGET_NAMES) }).strict(),
    z.object({ key: z.literal("voiceWidgetPeople"), value: z.enum(APP_WIDGET_PEOPLE) }).strict(),
    z.object({ key: z.literal("voiceWidgetOpacity"), value: z.enum(APP_WIDGET_OPACITIES) }).strict(),
    z.object({ key: z.literal("voiceWidgetCorner"), value: z.enum(APP_WIDGET_CORNERS) }).strict(),
    z
        .object({ key: z.literal("voiceWidgetMaxUsers"), value: z.number().int().min(0).max(APP_WIDGET_MAX_USERS) })
        .strict()
]);

export type AppSettingChange = z.infer<typeof appSettingChangeSchema>;

/** A change as the app accepts it, or null. */
export function readAppSettingChange(raw: unknown): AppSettingChange | null {
    const parsed = appSettingChangeSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
}

/** A key press a screen hands over to become the launcher's shortcut. */
export const appKeyPressSchema = z.object({
    code: z.string().min(1).max(40),
    ctrlKey: z.boolean(),
    metaKey: z.boolean(),
    altKey: z.boolean(),
    shiftKey: z.boolean()
});

export type AppKeyPress = z.infer<typeof appKeyPressSchema>;

/**
 * Where the app's settings open when somebody asks for them (tray, menu, the
 * button on the "can't connect" screen): the host's own Settings when its page
 * is loaded and has said it draws them, else the page bundled with the app,
 * which needs no network and no particular host version.
 */
export function appSettingsTarget(state: {
    readonly pageLoaded: boolean;
    readonly pageAnnounced: boolean;
}): "host" | "local" {
    return state.pageLoaded && state.pageAnnounced ? "host" : "local";
}

/**
 * The categories the phone app lists, of the same group: its servers, and the
 * rest of what it keeps on the phone (notifications, language, Vault autofill)
 * under General. The other categories are the desktop app's alone; the app's
 * version and its updates head General (and Downloads, on the phone).
 */
export const APP_PHONE_CATEGORIES = ["general", "hosts"] as const satisfies readonly AppSettingCategory[];

export type AppPhoneCategory = (typeof APP_PHONE_CATEGORIES)[number];

/** Whether the phone app lists a category. */
export function phoneHasCategory(category: AppSettingCategory): category is AppPhoneCategory {
    return (APP_PHONE_CATEGORIES as readonly string[]).includes(category);
}

/**
 * What the phone app opens from its General category, in the order listed.
 * Each one is a screen of the app or of the phone itself (its notification
 * and language settings), so the values never cross the bridge: the page only
 * asks for the screen. The app names the ones this phone has.
 */
export const APP_PHONE_ACTIONS = ["notifications", "language", "vault", "browser"] as const;

export type AppPhoneAction = (typeof APP_PHONE_ACTIONS)[number];

const phoneSnapshotSchema = z.object({
    version: z.string().max(64).catch(""),
    server: z.string().max(2048).nullable().catch(null),
    servers: z.array(savedHostSchema).max(200).catch([]),
    /** Unknown names, from a newer app, are dropped rather than failing the rest. */
    actions: z
        .array(z.string().max(32))
        .max(16)
        .catch([])
        .transform((names) => APP_PHONE_ACTIONS.filter((action) => names.includes(action))),
    /** "check" when this copy updates itself, "store" when a store does, "none" when the app cannot say. */
    updates: z.enum(["check", "store", "none"]).catch("none")
});

export type AppPhoneSnapshot = z.infer<typeof phoneSnapshotSchema>;

/** The phone app's answer (a JSON text, as its bridge returns one) as a snapshot, or null. */
export function readPhoneAppSettings(raw: unknown): AppPhoneSnapshot | null {
    let value = raw;
    if (typeof raw === "string") {
        if (raw.length > 256 * 1024) return null;
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const parsed = phoneSnapshotSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}

/** An action the page asks the phone app for, or null for one it does not know. */
export function readPhoneAppAction(raw: unknown): AppPhoneAction | null {
    const parsed = z.enum(APP_PHONE_ACTIONS).safeParse(raw);
    return parsed.success ? parsed.data : null;
}

const phoneUpdateCheckSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("current") }),
    z.object({ kind: z.literal("failed") }),
    z.object({ kind: z.literal("store") }),
    z.object({ kind: z.literal("available"), version: z.string().min(1).max(64) })
]);

export type AppPhoneUpdateCheck = z.infer<typeof phoneUpdateCheckSchema>;

/** What the phone app answered a check for updates with; anything unreadable counts as a check that failed. */
export function readPhoneUpdateCheck(raw: unknown): AppPhoneUpdateCheck {
    let value = raw;
    if (typeof raw === "string") {
        try {
            value = JSON.parse(raw);
        } catch {
            return { kind: "failed" };
        }
    }
    const parsed = phoneUpdateCheckSchema.safeParse(value);
    return parsed.success ? parsed.data : { kind: "failed" };
}
