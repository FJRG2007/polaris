/**
 * What the vulnerability scans found in Polaris's own images on this machine,
 * for the Updates card. Only scans that ran are counted - nothing is estimated:
 * no scan of Polaris's own images means no line on the card.
 *
 * The newest scan per image reference decides, so an image an update already
 * replaced (same reference, older id) is never counted for the one running
 * now: when the newest scan of a reference failed, that reference is reported
 * as not scanned rather than with an older image's numbers. Server-only.
 */

import { prisma } from "@polaris/db";

/** How old the newest scan may be and still be shown. */
const WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Polaris's own images are read from this many newest scans. */
export const OWN_SCANS = 200;

export interface OwnImageScan {
    readonly label: string;
    /** queued | running | done | failed */
    readonly state: string;
    readonly imageId: string | null;
    readonly summary: string;
    readonly finishedAt: Date | null;
}

export interface OwnVulnerabilities {
    /** Images whose newest scan counted. */
    readonly images: number;
    readonly critical: number;
    readonly high: number;
    /** Images whose newest scan failed: nothing is known about what they run. */
    readonly failed: number;
    /** When the oldest of the counted scans finished (ISO 8601). */
    readonly scannedAt: string | null;
}

function count(summary: string, key: "critical" | "high"): number {
    try {
        const value = (JSON.parse(summary) as Record<string, unknown>)[key];
        return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
    } catch {
        return 0;
    }
}

/** Newest scan per image reference (its label); `rows` arrive newest first. Pure. */
export function newestPerRef<T extends { label: string }>(rows: readonly T[]): T[] {
    const seen = new Map<string, T>();
    for (const row of rows) if (!seen.has(row.label)) seen.set(row.label, row);
    return [...seen.values()];
}

/** Scans of Polaris's own images on this machine recent enough to be shown. */
export function ownScansWhere(now: Date) {
    return {
        source: "polaris",
        kind: "image",
        createdAt: { gt: new Date(now.getTime() - WINDOW_MS) },
        target: { kind: "local" }
    } as const;
}

/**
 * The scan that speaks for a reference now. Its newest one when that finished;
 * while a newer one waits or runs, the newest finished scan of that same image
 * id - never one of an image the reference no longer runs. Null when there is
 * none, or when the newest one failed. `rows` are one reference's, newest
 * first. Pure.
 */
export function currentScan<T extends Pick<OwnImageScan, "state" | "imageId">>(
    rows: readonly T[]
): T | null {
    const newest = rows[0];
    if (!newest) return null;
    if (newest.state === "done") return newest;
    if (newest.state === "failed" || newest.imageId === null) return null;
    return rows.find((row) => row.state === "done" && row.imageId === newest.imageId) ?? null;
}

/** Each reference's current scan, summed. `scans` arrive newest first. Pure. */
export function summarizeOwnScans(scans: readonly OwnImageScan[]): OwnVulnerabilities | null {
    const byRef = new Map<string, OwnImageScan[]>();
    for (const scan of scans) byRef.set(scan.label, [...(byRef.get(scan.label) ?? []), scan]);
    let images = 0;
    let failed = 0;
    let critical = 0;
    let high = 0;
    let oldest: Date | null = null;
    for (const rows of byRef.values()) {
        if (rows[0]?.state === "failed") failed += 1;
        const scan = currentScan(rows);
        if (!scan) continue;
        images += 1;
        critical += count(scan.summary, "critical");
        high += count(scan.summary, "high");
        if (scan.finishedAt && (!oldest || scan.finishedAt < oldest)) oldest = scan.finishedAt;
    }
    if (images === 0 && failed === 0) return null;
    return { images, critical, high, failed, scannedAt: oldest?.toISOString() ?? null };
}

export async function ownVulnerabilities(now = new Date()): Promise<OwnVulnerabilities | null> {
    const scans = await prisma.securityScan.findMany({
        where: ownScansWhere(now),
        orderBy: { createdAt: "desc" },
        take: OWN_SCANS,
        select: { label: true, state: true, imageId: true, summary: true, finishedAt: true }
    });
    return summarizeOwnScans(scans);
}
