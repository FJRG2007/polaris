/**
 * What the owner of a connected TV asks it to do from /account/tv (a phone, as
 * often as not, reached through the TV's own QR), and what the TV says it did.
 *
 * Same shape as an update request: nothing reaches into the TV. The owner's
 * choice is stored per TV, the TV reads it as `desired` on its next poll of
 * /api/tv/state, applies it itself, and reports the outcome on the poll after
 * (`?blocking=`). One row per TV, so this never grows past the TVs connected.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";

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

/** An identifier from the TV catalog (a theme or an add-on). */
const catalogId = z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9._-]*$/);

/**
 * What a TV is asked to be. `theme` and `addons` are carried for the catalog
 * picker that comes later; nothing sets them yet, and a TV that does not know
 * them ignores them.
 */
export const tvDesiredSchema = z
    .object({
        blocking: z.boolean(),
        theme: catalogId.optional(),
        addons: z.array(catalogId).max(50).optional()
    })
    .strict();
export type TvDesired = z.infer<typeof tvDesiredSchema>;

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

/** The report a TV puts on its poll; anything malformed is ignored, never refused. */
export function reportedBlocking(request: Request): TvBlockingReport | null {
    return readReport(new URL(request.url).searchParams.get("blocking"));
}

/** What the TV should be, for its poll. Null when its owner never chose. */
export async function desiredFor(keyId: string): Promise<TvDesired | null> {
    const row = await prisma.tvPreference.findUnique({
        where: { apiKeyId: keyId },
        select: { desired: true }
    });
    return readDesired(row?.desired);
}

/** Keep what the TV reports, writing only when it changed. */
export async function noteTvBlocking(
    keyId: string,
    userId: string,
    report: TvBlockingReport,
    now = new Date()
): Promise<void> {
    const row = await prisma.tvPreference.findUnique({
        where: { apiKeyId: keyId },
        select: { applied: true }
    });
    if (row?.applied === report) return;
    await prisma.tvPreference.upsert({
        where: { apiKeyId: keyId },
        create: { apiKeyId: keyId, userId, applied: report, appliedAt: now },
        update: { applied: report, appliedAt: now }
    });
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

async function ownsTv(userId: string, keyId: string, now: Date): Promise<boolean> {
    const key = await prisma.apiKey.findFirst({
        where: { ...connectedTvWhere(userId, now), id: keyId },
        select: { id: true }
    });
    return Boolean(key);
}

/**
 * Turn Block ads and trackers on or off for one of the account's TVs. Keeps
 * whatever else was asked of it. False when the key is not a TV of this account.
 */
export async function setTvBlocking(
    userId: string,
    keyId: string,
    blocking: boolean,
    now = new Date()
): Promise<boolean> {
    if (!(await ownsTv(userId, keyId, now))) return false;
    const row = await prisma.tvPreference.findUnique({
        where: { apiKeyId: keyId },
        select: { desired: true }
    });
    const desired: TvDesired = { ...(readDesired(row?.desired) ?? {}), blocking };
    await prisma.tvPreference.upsert({
        where: { apiKeyId: keyId },
        create: { apiKeyId: keyId, userId, desired },
        update: { desired }
    });
    return true;
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
