/**
 * The published app catalogue: apps an existing install can discover, install
 * and update without a new dashboard image, the way a phone's store lists an
 * app published after the phone was bought.
 *
 * Each entry carries everything the host needs to show the app with no code of
 * its own for it: its names and descriptions in every locale, its logo, its nav
 * entry, the permissions it uses, the host API it needs, and the digest of its
 * bundle. The catalogue is signed (see `runtime-catalog.ts`); this module only
 * reads it, so it is pure and client-safe.
 *
 * An entry this dashboard cannot read - a field from a newer catalogue, a
 * permission it does not know - is dropped on its own or offered as "needs a
 * newer Polaris"; it never takes the rest of the catalogue down with it.
 */

import { z } from "zod";
import { Package } from "lucide-react";
import type { AppCategory, AppManifest } from "./catalog";
import { HOST_API, hostApiVerdict } from "@polaris/app-host/version";

/** Where the signed catalogue is published: the same repository releases the device plugin catalog lives on. */
export const APP_CATALOG_URL = "https://github.com/FJRG2007/polaris/releases/download/app-catalog/catalog.json";

/** The largest catalogue read. */
export const APP_CATALOG_MAX_BYTES = 1024 * 1024;

/** Where a runtime app's screens are served: one route in every image, so no new route is needed per app. */
export const RUNTIME_APP_BASE = "/x";

/** Logos and screenshots come from the catalogue's own release, never from an arbitrary host. */
const ASSET_PREFIX = "https://github.com/FJRG2007/polaris/releases/download/app-catalog/";

const APP_ID = /^[a-z][a-z0-9-]{1,47}$/;
const PERMISSION = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9.-]{0,47}$/;

const CATEGORIES: readonly AppCategory[] = ["Messaging", "Productivity", "AI", "Games", "Game servers", "Home", "Tools"];

const localized = (max: number) =>
    z.object({ "en-US": z.string().trim().min(1).max(max) }).catchall(z.string().trim().min(1).max(max));

export const runtimeAppEntrySchema = z.object({
    id: z.string().regex(APP_ID),
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/),
    /** The host API the bundle needs (`@polaris/app-host/version`): the real gate. */
    hostApi: z.string().regex(/^\d{1,4}\.\d{1,4}$/),
    /** The first Polaris release that provides it, for the "needs Polaris X" sentence. */
    /**
     * Shown only: "Needs Polaris X". What decides is `hostApi`, the host contract
     * version that moves whenever the contract does; the dashboard's package
     * version does not move with releases, so it never gates anything.
     */
    minPolaris: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,6}$/).optional(),
    name: localized(60),
    summary: localized(140),
    description: localized(1_000),
    category: z.string().max(40),
    keywords: z.array(z.string().trim().min(1).max(40)).max(12).default([]),
    logo: z.string().url().startsWith(ASSET_PREFIX).max(300).optional(),
    nav: z
        .object({
            /** The rail group it sits in (`AppEntry.category`). */
            category: z.string().regex(/^[a-z][a-z-]{0,31}$/),
            /** What a person needs to see it: one of the permissions the app declares. */
            permission: z.string().regex(PERMISSION)
        })
        .optional(),
    permissions: z.array(z.string().regex(PERMISSION)).max(32).default([]),
    /**
     * The permissions the app brings, under its own id (`<id>.<action>`). They
     * join the roles editor and the server's checks when the app is registered
     * (`registerAppPermissions` in `@polaris/core`): an app never edits core.
     */
    permissionDefs: z
        .array(
            z.object({
                key: z.string().regex(PERMISSION),
                label: localized(80),
                implies: z.array(z.string().regex(PERMISSION)).max(8).default([]),
                /** It changes something: the read-only policy template denies it. */
                writes: z.boolean().default(false)
            })
        )
        .max(16)
        .default([]),
    /** The automation trigger events it emits, each `<id>.<event>` with typed payload fields. */
    events: z
        .array(
            z.object({
                name: z.string().regex(/^[a-z][a-z0-9-]{1,47}\.[a-z][a-z0-9.-]{0,63}$/),
                label: localized(80),
                fields: z.record(z.enum(["string", "number", "boolean", "id"])).default({})
            })
        )
        .max(32)
        .default([]),
    /** The bundle, pinned by digest: fetched from the dashboard's own registry and refused unless it hashes to this. */
    bundle: z.object({
        file: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,95}\.zip$/),
        digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
        size: z.number().int().positive().max(200 * 1024 * 1024)
    }),
    /**
     * Tables the app keeps in the core schema. An app with core tables needs the
     * dashboard release that carries their migration, so a host without it is
     * told to update (phase 2 moves app tables to an app-owned schema).
     */
    coreTables: z.boolean().default(false),
    published: z.string().datetime()
});

export type RuntimeAppEntry = z.infer<typeof runtimeAppEntrySchema>;

/** `needsPolaris` for an entry that names no release: the card says "a newer Polaris". */
export const NEWER_POLARIS = "newer";

const envelopeSchema = z.object({
    schema: z.literal(1),
    kind: z.literal("apps"),
    /** When it was signed: a held catalogue is never traded for an older one. */
    issued: z.string().datetime(),
    apps: z.array(z.unknown()).max(500)
});

export interface RuntimeAppCatalog {
    readonly issued: string;
    readonly apps: readonly RuntimeAppEntry[];
}

/** The catalogue in `value`, keeping every entry that reads and the first of any repeated id; null when the envelope does not read. */
export function readAppCatalog(value: unknown): RuntimeAppCatalog | null {
    const envelope = envelopeSchema.safeParse(value);
    if (!envelope.success) return null;
    const seen = new Set<string>();
    const apps: RuntimeAppEntry[] = [];
    for (const raw of envelope.data.apps) {
        const entry = runtimeAppEntrySchema.safeParse(raw);
        if (!entry.success || seen.has(entry.data.id)) continue;
        seen.add(entry.data.id);
        apps.push(entry.data);
    }
    return { issued: envelope.data.issued, apps };
}

export type RuntimeAppFit =
    | { readonly ok: true }
    /** This dashboard is older than the app needs: offered with "needs Polaris X - Update". */
    | { readonly ok: false; readonly needs: "polaris"; readonly version: string }
    /** Written for a host API this dashboard has moved past: not offered at all. */
    | { readonly ok: false; readonly needs: "app" };

/** Whether this dashboard can run an entry: its host API, the permissions it uses, and where its tables live. */
export function appEntryFit(
    entry: RuntimeAppEntry,
    known: ReadonlySet<string>,
    hostApi: string = HOST_API
): RuntimeAppFit {
    const verdict = hostApiVerdict(entry.hostApi, hostApi);
    if (!verdict.ok && verdict.update === "app") return { ok: false, needs: "app" };
    const newer = { ok: false, needs: "polaris", version: entry.minPolaris ?? NEWER_POLARIS } as const;
    if (!verdict.ok || entry.coreTables) return newer;
    const uses = entry.nav ? [...entry.permissions, entry.nav.permission] : entry.permissions;
    // Its own permissions it brings with it; any other must be one this dashboard has.
    const own = new Set(
        entry.permissionDefs.map((definition) => definition.key).filter((key) => key.startsWith(`${entry.id}.`) && !known.has(key))
    );
    if (uses.some((permission) => !known.has(permission) && !own.has(permission))) return newer;
    if (entry.nav && !entry.permissions.includes(entry.nav.permission)) return newer;
    return { ok: true };
}

/** The text of `words` for `locale`, its language's, or the English every entry has. */
export function entryText(words: Readonly<Record<string, string>>, locale: string): string {
    const language = locale.split("-")[0];
    const near = Object.keys(words).find((key) => key.split("-")[0] === language);
    return words[locale] ?? (near ? words[near] : undefined) ?? (words["en-US"] as string);
}

/** A runtime entry as the screens read a manifest, in one locale. Serializable apart from the icon. */
export function runtimeManifest(entry: RuntimeAppEntry, fit: RuntimeAppFit, locale: string): AppManifest {
    return {
        id: entry.id,
        name: entryText(entry.name, locale),
        summary: entryText(entry.summary, locale),
        description: entryText(entry.description, locale),
        category: (CATEGORIES as readonly string[]).includes(entry.category) ? (entry.category as AppCategory) : "Tools",
        icon: Package,
        keywords: entry.keywords,
        installMethod: "builtin",
        capabilities: ["tool"],
        dashboard: "builtin",
        singleton: true,
        instanceWide: true,
        opensAt: `${RUNTIME_APP_BASE}/${entry.id}`,
        ...(entry.logo ? { logo: entry.logo } : {}),
        ...(fit.ok ? {} : { needsPolaris: entry.minPolaris ?? NEWER_POLARIS }),
        runtime: { version: entry.version }
    };
}

/** What the browser is handed to register: plain data, the icon added back on its side. */
export type RuntimeAppView = Omit<AppManifest, "icon"> & {
    readonly nav?: RuntimeAppEntry["nav"];
    /** Its own permissions, labelled in the reader's language, for a runnable entry. */
    readonly permissionDefs?: readonly { key: string; label: string; implies: readonly string[]; writes: boolean }[];
    /** Its automation trigger events, labelled in the reader's language. */
    readonly events?: readonly { name: string; label: string; fields: Readonly<Record<string, "string" | "number" | "boolean" | "id">> }[];
};

/** The entries a dashboard lists, with the ones written for a host API it has moved past left out. */
export function runtimeViews(catalog: RuntimeAppCatalog | null, known: ReadonlySet<string>, locale: string): RuntimeAppView[] {
    const views: RuntimeAppView[] = [];
    for (const entry of catalog?.apps ?? []) {
        const fit = appEntryFit(entry, known);
        if (!fit.ok && fit.needs === "app") continue;
        const { icon: _icon, ...view } = runtimeManifest(entry, fit, locale);
        if (!fit.ok) {
            views.push(view);
            continue;
        }
        const permissionDefs = entry.permissionDefs.map((definition) => ({
            key: definition.key,
            label: entryText(definition.label, locale),
            implies: definition.implies,
            writes: definition.writes
        }));
        const events = entry.events.map((event) => ({ name: event.name, label: entryText(event.label, locale), fields: event.fields }));
        views.push({
            ...view,
            ...(entry.nav ? { nav: entry.nav } : {}),
            ...(permissionDefs.length ? { permissionDefs } : {}),
            ...(events.length ? { events } : {})
        });
    }
    return views;
}
