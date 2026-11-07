/**
 * Asking a connected Polaris TV to update, and hearing back from it.
 *
 * Nothing reaches into the TV: /account/tv writes one request per TV, the TV
 * collects it on its next poll of /api/tv/state, and reports how it went to
 * /api/tv/update/report under the request's id. One row per TV, replaced by the
 * next request, so this never grows past the number of connected TVs.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { randomUUID } from "node:crypto";
import { compareTvVersions } from "@/lib/tv/version-order";

export const TV_UPDATE_STATES = [
    "queued",
    "downloading",
    "waiting-confirmation",
    "installing",
    "done",
    "failed"
] as const;
export type TvUpdateState = (typeof TV_UPDATE_STATES)[number];

/** States in which a request is still the TV's to carry out. */
const PENDING: readonly TvUpdateState[] = [
    "queued",
    "downloading",
    "waiting-confirmation",
    "installing"
];

/** A request the TV has not finished after this long may be asked for again:
 *  a TV switched off mid-install must not hold the button down for ever. */
export const TV_UPDATE_STALE_MS = 24 * 60 * 60 * 1000;

export const TV_REASON_MAX = 200;

/** What a TV reports; the reason is its own words, kept short and printable. */
export const tvUpdateReportSchema = z.object({
    id: z.string().uuid(),
    state: z.enum(["downloading", "waiting-confirmation", "installing", "done", "failed"]),
    reason: z
        .string()
        .trim()
        .max(TV_REASON_MAX)
        .regex(/^[^\p{Cc}]*$/u)
        .optional()
});
export type TvUpdateReport = z.infer<typeof tvUpdateReportSchema>;

/** What a TV says it is running. */
export const tvVersionSchema = z.object({
    versionName: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .regex(/^[0-9A-Za-z.+-]+$/),
    versionCode: z.coerce.number().int().min(1).max(2_100_000_000).optional()
});
export type TvVersion = z.infer<typeof tvVersionSchema>;

/** The version a TV names in its user agent ("polaris-tv/3.4"), for sets that
 *  predate reporting it explicitly. */
export function versionFromUserAgent(agent: string | null): string | null {
    const match = /^polaris-tv\/([0-9A-Za-z.+-]{1,40})$/.exec(agent?.trim() ?? "");
    return match ? match[1]! : null;
}

export function isPendingTvUpdate(state: string): boolean {
    return (PENDING as readonly string[]).includes(state);
}

/** One connected TV, as /account/tv lists it. */
export interface TvRow {
    readonly id: string;
    readonly name: string;
    readonly versionName: string | null;
    readonly versionCode: number | null;
    readonly lastSeenAt: string | null;
    readonly update: {
        readonly versionName: string;
        readonly state: TvUpdateState;
        readonly reason: string | null;
        readonly at: string;
    } | null;
}

function connectedWhere(userId: string, now: Date) {
    return {
        userId,
        kind: "tv",
        revokedAt: null,
        enabled: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
    };
}

/** Bounded: a person has a few TVs, not thousands. */
const MAX_TVS = 100;

export async function listTvs(userId: string, now = new Date()): Promise<TvRow[]> {
    const keys = await prisma.apiKey.findMany({
        where: connectedWhere(userId, now),
        select: {
            id: true,
            clientName: true,
            name: true,
            clientVersion: true,
            clientBuild: true,
            lastUsedAt: true,
            tvUpdate: {
                select: { versionName: true, state: true, reason: true, updatedAt: true }
            }
        },
        orderBy: { createdAt: "asc" },
        take: MAX_TVS
    });
    return keys.map((key) => ({
        id: key.id,
        name: key.clientName ?? key.name,
        versionName: key.clientVersion,
        versionCode: key.clientBuild,
        lastSeenAt: key.lastUsedAt?.toISOString() ?? null,
        update: key.tvUpdate
            ? {
                  versionName: key.tvUpdate.versionName,
                  state: (TV_UPDATE_STATES as readonly string[]).includes(key.tvUpdate.state)
                      ? (key.tvUpdate.state as TvUpdateState)
                      : "failed",
                  reason: key.tvUpdate.reason,
                  at: key.tvUpdate.updatedAt.toISOString()
              }
            : null
    }));
}

function isUniqueViolation(error: unknown): boolean {
    return (error as { code?: string } | null)?.code === "P2002";
}

/**
 * Ask the given TVs (all of the account's, when `only` is null) to install
 * `versionName`. Idempotent: a TV with a request still pending, or already on
 * that version or newer, is left alone. Returns the ids that were queued.
 */
export async function requestTvUpdates(
    userId: string,
    only: readonly string[] | null,
    versionName: string,
    now = new Date()
): Promise<string[]> {
    const keys = await prisma.apiKey.findMany({
        where: { ...connectedWhere(userId, now), ...(only ? { id: { in: [...only] } } : {}) },
        select: {
            id: true,
            clientVersion: true,
            tvUpdate: { select: { requestId: true, state: true, updatedAt: true } }
        },
        take: MAX_TVS
    });
    const queued: string[] = [];
    for (const key of keys) {
        if (key.clientVersion && compareTvVersions(key.clientVersion, versionName) >= 0) continue;
        const held = key.tvUpdate;
        const fresh = held && now.getTime() - held.updatedAt.getTime() < TV_UPDATE_STALE_MS;
        if (held && isPendingTvUpdate(held.state) && fresh) continue;
        const data = { requestId: randomUUID(), versionName, state: "queued", reason: null };
        if (held) {
            // Compare-and-swap on the request it replaces, so two presses at once
            // queue one request, not two.
            const swapped = await prisma.tvUpdateRequest.updateMany({
                where: { apiKeyId: key.id, requestId: held.requestId },
                data
            });
            if (swapped.count > 0) queued.push(key.id);
            continue;
        }
        try {
            await prisma.tvUpdateRequest.create({ data: { ...data, apiKeyId: key.id, userId } });
            queued.push(key.id);
        } catch (caught) {
            if (!isUniqueViolation(caught)) throw caught;
        }
    }
    return queued;
}

/** The request a TV should be carrying out, for its poll. */
export async function pendingTvUpdate(
    keyId: string
): Promise<{ id: string; versionName: string } | null> {
    const row = await prisma.tvUpdateRequest.findUnique({
        where: { apiKeyId: keyId },
        select: { requestId: true, versionName: true, state: true }
    });
    if (!row || !isPendingTvUpdate(row.state)) return null;
    return { id: row.requestId, versionName: row.versionName };
}

/**
 * Record a TV's progress. False when the id is not the TV's current request or
 * that request already finished, so a late or replayed report changes nothing.
 */
export async function reportTvUpdate(keyId: string, report: TvUpdateReport): Promise<boolean> {
    const reason = report.state === "failed" ? report.reason || null : null;
    const updated = await prisma.tvUpdateRequest.updateMany({
        where: { apiKeyId: keyId, requestId: report.id, state: { in: [...PENDING] } },
        data: { state: report.state, reason }
    });
    return updated.count > 0;
}

/**
 * Keep what a TV says it runs. Writes only when it changed; when it did and the
 * TV now runs the version it was asked for, that request is done.
 */
export async function noteTvVersion(keyId: string, version: TvVersion): Promise<void> {
    const current = await prisma.apiKey.findUnique({
        where: { id: keyId },
        select: { clientVersion: true, clientBuild: true }
    });
    if (!current) return;
    const sameName = current.clientVersion === version.versionName;
    // A TV that names only its version (an older one, by user agent) keeps the
    // build it reported for that version, and loses it when the version moves.
    const build = version.versionCode ?? (sameName ? current.clientBuild : null);
    if (sameName && build === current.clientBuild) return;
    await prisma.apiKey.update({
        where: { id: keyId },
        data: { clientVersion: version.versionName, clientBuild: build }
    });
    const row = await prisma.tvUpdateRequest.findUnique({
        where: { apiKeyId: keyId },
        select: { versionName: true, state: true }
    });
    if (!row || !isPendingTvUpdate(row.state)) return;
    if (compareTvVersions(version.versionName, row.versionName) < 0) return;
    await prisma.tvUpdateRequest.updateMany({
        where: { apiKeyId: keyId, state: { in: [...PENDING] } },
        data: { state: "done", reason: null }
    });
}
