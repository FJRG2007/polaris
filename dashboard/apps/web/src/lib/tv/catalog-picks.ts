/**
 * Themes and add-ons picked for a TV from /account/tv, by the same mechanism as
 * Block ads and trackers (lib/tv/preferences): the pick is stored on the TV's
 * row as `desired.theme` / `desired.addons`, each with its own choice id, the TV
 * reads it on its next poll of /api/tv/state, applies it once, and reports on a
 * later poll (`?theme=&themeChoice=`, `?addons=&addonsChoice=`). A report for a
 * choice that is no longer the latest, or a malformed one, is ignored.
 *
 * The list to pick from is the newest release's catalog, read from the copy this
 * instance already verified for its TVs (lib/tv/release).
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { tvTakesCatalog } from "@/lib/tv/version-order";
import { preparedTvCatalogFile, TV_CATALOG_NAME } from "@/lib/tv/release";
import {
    connectedTvWhere,
    readDesired,
    tvCatalogIdSchema,
    TV_ADDONS_MAX,
    TV_ADDONS_REPORTS,
    TV_THEME_REPORTS,
    type TvAddonsReport,
    type TvDesired,
    type TvThemeReport
} from "@/lib/tv/preferences";

/** One theme or add-on of the catalog, as /account/tv lists it. */
export interface TvCatalogEntry {
    readonly id: string;
    readonly kind: "theme" | "addon";
    readonly name: string;
    readonly description: string;
    readonly network: boolean;
    readonly minSdk: number | null;
    readonly screenshot: string;
}

const entrySchema = z.object({
    id: tvCatalogIdSchema,
    kind: z.enum(["theme", "addon"]),
    name: z.string().trim().min(1).max(80),
    description: z.string().max(600).catch(""),
    network: z.boolean().catch(false),
    minSdk: z.number().int().positive().nullable().catch(null),
    screenshot: z.string()
});

/** The entries of a catalog.json that read cleanly, in order, without duplicates. Null for one this cannot read. */
export function parseTvCatalog(body: string): TvCatalogEntry[] | null {
    let root: unknown;
    try {
        root = JSON.parse(body);
    } catch {
        return null;
    }
    const shaped = z.object({ version: z.literal(1), items: z.array(z.unknown()) }).safeParse(root);
    if (!shaped.success) return null;
    const seen = new Set<string>();
    const out: TvCatalogEntry[] = [];
    for (const raw of shaped.data.items) {
        const parsed = entrySchema.safeParse(raw);
        if (!parsed.success) continue;
        const entry = parsed.data;
        // The generator names every screenshot after its entry; anything else is not one of its files.
        if (entry.screenshot !== `${entry.kind}-${entry.id}.jpg`) continue;
        if (seen.has(`${entry.kind}/${entry.id}`)) continue;
        seen.add(`${entry.kind}/${entry.id}`);
        out.push(entry);
    }
    return out;
}

/** The newest release's catalog, or null when there is none to read (no release, or one before the catalog). */
export async function readTvCatalog(): Promise<TvCatalogEntry[] | null> {
    const file = await preparedTvCatalogFile(TV_CATALOG_NAME).catch(() => null);
    if (!file) return null;
    return parseTvCatalog(await readFile(file.path, "utf8"));
}

export const tvThemeReportSchema = z.enum(TV_THEME_REPORTS);
export const tvAddonsReportSchema = z.enum(TV_ADDONS_REPORTS);
const choiceSchema = z.string().uuid();

export interface TvCatalogReported {
    readonly theme: { readonly report: TvThemeReport; readonly choice: string } | null;
    readonly addons: { readonly report: TvAddonsReport; readonly choice: string } | null;
}

/** What a TV says on its poll about its theme and add-ons; anything malformed is left out. */
export function reportedCatalog(request: Request): TvCatalogReported | null {
    const query = new URL(request.url).searchParams;
    function read<T extends string>(schema: z.ZodType<T>, key: string) {
        const report = schema.safeParse(query.get(key));
        const choice = choiceSchema.safeParse(query.get(`${key}Choice`));
        return report.success && choice.success
            ? { report: report.data, choice: choice.data.toLowerCase() }
            : null;
    }
    const theme = read(tvThemeReportSchema, "theme");
    const addons = read(tvAddonsReportSchema, "addons");
    return theme || addons ? { theme, addons } : null;
}

/** Keep what the TV said about its latest theme and add-ons choices, writing only when it changed. */
export async function noteTvCatalog(keyId: string, reported: TvCatalogReported): Promise<void> {
    const row = await prisma.tvPreference.findUnique({
        where: { apiKeyId: keyId },
        select: { desired: true }
    });
    const desired = readDesired(row?.desired);
    if (!desired) return;
    const next: TvDesired = { ...desired };
    let changed = false;
    if (reported.theme && desired.theme?.choice === reported.theme.choice) {
        if (desired.theme.applied !== reported.theme.report) {
            next.theme = { ...desired.theme, applied: reported.theme.report };
            changed = true;
        }
    }
    if (reported.addons && desired.addons?.choice === reported.addons.choice) {
        if (desired.addons.applied !== reported.addons.report) {
            next.addons = { ...desired.addons, applied: reported.addons.report };
            changed = true;
        }
    }
    if (changed) await prisma.tvPreference.updateMany({ where: { apiKeyId: keyId }, data: { desired: next } });
}

export const tvThemePickSchema = z.object({ keyId: z.string().uuid(), theme: tvCatalogIdSchema });
export const tvAddonsPickSchema = z.object({
    keyId: z.string().uuid(),
    addons: z
        .array(tvCatalogIdSchema)
        .max(TV_ADDONS_MAX)
        .transform((ids) => [...new Set(ids)].sort())
});

export type TvPickOutcome = "done" | "notATv" | "tooOld" | "notInCatalog";

/**
 * Store a new theme or add-ons choice for one of the account's TVs. Every call
 * is a new choice the TV acts on once; what it said about the last one is
 * cleared. `notInCatalog` when an id is not in the newest release's catalog.
 */
async function pick(
    userId: string,
    keyId: string,
    kind: "theme" | "addon",
    ids: readonly string[],
    now: Date
): Promise<TvPickOutcome> {
    const key = await prisma.apiKey.findFirst({
        where: { ...connectedTvWhere(userId, now), id: keyId },
        select: { clientBuild: true, tvPreference: { select: { desired: true } } }
    });
    if (!key) return "notATv";
    if (!tvTakesCatalog(key.clientBuild)) return "tooOld";
    const catalog = await readTvCatalog();
    const known = new Set(catalog?.filter((entry) => entry.kind === kind).map((entry) => entry.id));
    if (ids.some((id) => !known.has(id))) return "notInCatalog";
    const choice = randomUUID();
    const desired: TvDesired = {
        ...readDesired(key.tvPreference?.desired),
        ...(kind === "theme"
            ? { theme: { id: ids[0]!, choice, applied: null } }
            : { addons: { ids: [...ids], choice, applied: null } })
    };
    await prisma.tvPreference.upsert({
        where: { apiKeyId: keyId },
        create: { apiKeyId: keyId, userId, desired, askedAt: now },
        update: { desired }
    });
    return "done";
}

export function setTvTheme(userId: string, keyId: string, theme: string, now = new Date()) {
    return pick(userId, keyId, "theme", [theme], now);
}

export function setTvAddons(userId: string, keyId: string, addons: readonly string[], now = new Date()) {
    return pick(userId, keyId, "addon", addons, now);
}
