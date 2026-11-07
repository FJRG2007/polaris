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

/** What a TV is asked to be. */
export const tvDesiredSchema = z.object({ blocking: z.boolean() }).strict();
export type TvDesired = z.infer<typeof tvDesiredSchema>;

/** What a TV reads on its poll: the choice, and the id it names when it reports on it. */
export type TvDesiredForTv = TvDesired & { readonly choice: string | null };

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

const choiceSchema = z.string().uuid();

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
    return desired ? { ...desired, choice: row?.choice ?? null } : null;
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
        select: { clientBuild: true }
    });
    if (!key) return "notATv";
    if (!tvTakesBlocking(key.clientBuild)) return "tooOld";
    const desired: TvDesired = { blocking };
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
