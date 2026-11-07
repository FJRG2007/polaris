/**
 * What the owner of a connected TV asks it to do from /account/tv (a phone, as
 * often as not, reached through the TV's own QR), and what the TV says it did.
 *
 * Same shape as an update request: nothing reaches into the TV. The owner's
 * choice is stored per TV, the TV reads it as `desired` on its next poll of
 * /api/tv/state, applies it itself, and reports the outcome on a poll of its
 * own right after (`?blocking=&blockingChoice=`). One row per TV, so this never
 * grows past the TVs connected.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { tvTakesBlocking } from "@/lib/tv/version-order";

/** What the TV can say about Block ads and trackers. */
export const TV_BLOCKING_REPORTS = [
    "on",
    "off",
    "failed",
    "unavailable",
    "no-permission",
    "no-filter",
    "left-as-set"
] as const;
export type TvBlockingReport = (typeof TV_BLOCKING_REPORTS)[number];
export const tvBlockingReportSchema = z.enum(TV_BLOCKING_REPORTS);

/** A theme or add-on id as the catalog spells it (tv/tools/catalog.py). */
export const tvCatalogIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
/** The most add-ons one TV is asked to have. */
export const TV_ADDONS_MAX = 64;

/** What the TV can say about a theme it was asked to wear. */
export const TV_THEME_REPORTS = ["applied", "failed", "unavailable"] as const;
export type TvThemeReport = (typeof TV_THEME_REPORTS)[number];
/** What the TV can say about the add-ons it was asked to have: all there, Android
 *  is asking on the TV, one could not be installed, or one is not for this TV. */
export const TV_ADDONS_REPORTS = ["installed", "asked", "failed", "unavailable"] as const;
export type TvAddonsReport = (typeof TV_ADDONS_REPORTS)[number];

const choiceSchema = z.string().uuid();

/** A theme the owner picked, the id of that choice, and what the TV said about it. */
const themePickSchema = z
    .object({
        id: tvCatalogIdSchema,
        choice: choiceSchema,
        applied: z.enum(TV_THEME_REPORTS).nullable().optional()
    })
    .strict();
const addonsPickSchema = z
    .object({
        ids: z.array(tvCatalogIdSchema).max(TV_ADDONS_MAX),
        choice: choiceSchema,
        applied: z.enum(TV_ADDONS_REPORTS).nullable().optional()
    })
    .strict();

/**
 * What a TV is asked to be. Each part is its own choice with its own id, so a
 * new Block ads and trackers choice does not make the TV apply its theme again.
 * A row written before themes and add-ons (`{ blocking }`) still reads.
 */
export const tvDesiredSchema = z
    .object({
        blocking: z.boolean().optional(),
        theme: themePickSchema.optional(),
        addons: addonsPickSchema.optional()
    })
    .strict();
export type TvDesired = z.infer<typeof tvDesiredSchema>;

/** What a TV reads on its poll: each choice and the id it names when it reports on it. */
export interface TvDesiredForTv {
    readonly blocking?: boolean;
    readonly choice: string | null;
    readonly theme?: { readonly id: string; readonly choice: string };
    readonly addons?: { readonly ids: readonly string[]; readonly choice: string };
}

/** A stored row read back whole: anything that no longer parses counts as no choice. */
export function readDesired(stored: unknown): TvDesired | null {
    const parsed = tvDesiredSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
}

/** A stored report read back whole. */
export function readReport(stored: string | null | undefined): TvBlockingReport | null {
    const parsed = tvBlockingReportSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
}

/** A TV's report and the choice it answers (null: one it made by itself). */
export interface TvBlockingReported {
    readonly report: TvBlockingReport;
    readonly choice: string | null;
}

/** The report a TV puts on its poll; anything malformed is ignored, never refused. */
export function reportedBlocking(request: Request): TvBlockingReported | null {
    const query = new URL(request.url).searchParams;
    const report = readReport(query.get("blocking"));
    if (!report) return null;
    const choice = choiceSchema.safeParse(query.get("blockingChoice"));
    return { report, choice: choice.success ? choice.data.toLowerCase() : null };
}

/** What the TV should be, for its poll. Null when its owner never chose. */
export async function desiredFor(keyId: string): Promise<TvDesiredForTv | null> {
    const row = await prisma.tvPreference.findUnique({
        where: { apiKeyId: keyId },
        select: { desired: true, choice: true }
    });
    const desired = readDesired(row?.desired);
    if (!desired) return null;
    const { blocking, theme, addons } = desired;
    if (blocking === undefined && !theme && !addons) return null;
    return {
        ...(blocking === undefined ? {} : { blocking }),
        choice: row?.choice ?? null,
        ...(theme ? { theme: { id: theme.id, choice: theme.choice } } : {}),
        ...(addons ? { addons: { ids: addons.ids, choice: addons.choice } } : {})
    };
}

function isUniqueViolation(caught: unknown): boolean {
    return (
        typeof caught === "object" &&
        caught !== null &&
        (caught as { code?: unknown }).code === "P2002"
    );
}

/**
 * Keep what the TV reports, writing only when it changed. A report is kept only
 * for the choice the owner made last: one about an earlier choice, or one the
 * TV made by itself after the owner chose, waits for the TV to answer this one.
 */
export async function noteTvBlocking(
    keyId: string,
    userId: string,
    reported: TvBlockingReported,
    now = new Date()
): Promise<void> {
    const { report, choice } = reported;
    const row = await prisma.tvPreference.findUnique({
        where: { apiKeyId: keyId },
        select: { applied: true, choice: true }
    });
    if (row && (row.choice !== choice || row.applied === report)) return;
    const data = { applied: report, appliedAt: now };
    if (row) {
        await prisma.tvPreference.updateMany({ where: { apiKeyId: keyId, choice }, data });
        return;
    }
    if (choice !== null) return;
    try {
        await prisma.tvPreference.create({ data: { apiKeyId: keyId, userId, ...data } });
    } catch (caught) {
        if (!isUniqueViolation(caught)) throw caught;
        await prisma.tvPreference.updateMany({ where: { apiKeyId: keyId, choice: null }, data });
    }
}

/** A key that is one of this account's connected TVs, now. */
export function connectedTvWhere(userId: string, now: Date) {
    return {
        userId,
        kind: "tv",
        revokedAt: null,
        enabled: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    };
}

/**
 * Turn Block ads and trackers on or off for one of the account's TVs. Every
 * call is a new choice: the TV acts on it once, even when it asks for what it
 * asked before, and what the TV said about the last one is cleared until it
 * answers this one. `notATv` when the key is not a TV of this account, `tooOld`
 * when its launcher does not act on the switch.
 */
export async function setTvBlocking(
    userId: string,
    keyId: string,
    blocking: boolean,
    now = new Date()
): Promise<"done" | "notATv" | "tooOld"> {
    const key = await prisma.apiKey.findFirst({
        where: { ...connectedTvWhere(userId, now), id: keyId },
        select: { clientBuild: true, tvPreference: { select: { desired: true } } }
    });
    if (!key) return "notATv";
    if (!tvTakesBlocking(key.clientBuild)) return "tooOld";
    // The theme and add-ons asked before are kept as they are.
    const desired: TvDesired = { ...readDesired(key.tvPreference?.desired), blocking };
    const choice = { desired, choice: randomUUID(), askedAt: now, applied: null, appliedAt: null };
    await prisma.tvPreference.upsert({
        where: { apiKeyId: keyId },
        create: { apiKeyId: keyId, userId, ...choice },
        update: choice
    });
    return "done";
}

/** Rename one of the account's TVs. False when the key is not a TV of this account. */
export async function renameTv(
    userId: string,
    keyId: string,
    name: string,
    now = new Date()
): Promise<boolean> {
    const renamed = await prisma.apiKey.updateMany({
        where: { ...connectedTvWhere(userId, now), id: keyId },
        data: { clientName: name }
    });
    return renamed.count > 0;
}
