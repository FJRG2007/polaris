/**
 * What the vulnerability scans found in Polaris's own images on this machine,
 * for the Updates card. Only scans that ran are counted - nothing is estimated:
 * no scan of Polaris's own images means no line on the card.
 *
 * The newest finished scan per image reference counts, so an image an update
 * already replaced (same reference, older id) is not added on top of the one
 * running now. Server-only.
 */

import { prisma } from "@polaris/db";

/** How old the newest scan may be and still be shown. */
const WINDOW_MS = 30 * 24 * 60 * 60_000;

export interface OwnImageScan {
    readonly label: string;
    readonly summary: string;
    readonly finishedAt: Date | null;
}

export interface OwnVulnerabilities {
    readonly images: number;
    readonly critical: number;
    readonly high: number;
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

/** Newest scan per reference, summed. `scans` arrive newest first. Pure. */
export function summarizeOwnScans(scans: readonly OwnImageScan[]): OwnVulnerabilities | null {
    const newest = new Map<string, OwnImageScan>();
    for (const scan of scans) if (!newest.has(scan.label)) newest.set(scan.label, scan);
    if (newest.size === 0) return null;
    let critical = 0;
    let high = 0;
    let oldest: Date | null = null;
    for (const scan of newest.values()) {
        critical += count(scan.summary, "critical");
        high += count(scan.summary, "high");
        if (scan.finishedAt && (!oldest || scan.finishedAt < oldest)) oldest = scan.finishedAt;
    }
    return { images: newest.size, critical, high, scannedAt: oldest?.toISOString() ?? null };
}

export async function ownVulnerabilities(now = new Date()): Promise<OwnVulnerabilities | null> {
    const scans = await prisma.securityScan.findMany({
        where: {
            source: "polaris",
            kind: "image",
            state: "done",
            createdAt: { gt: new Date(now.getTime() - WINDOW_MS) },
            target: { kind: "local" }
        },
        orderBy: { createdAt: "desc" },
        take: 200,
        select: { label: true, summary: true, finishedAt: true }
    });
    return summarizeOwnScans(scans);
}
