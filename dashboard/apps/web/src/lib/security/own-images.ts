/**
 * What the vulnerability scans found in Polaris's own images on this machine,
 * for the Updates card. Only scans that ran are counted - nothing is estimated:
 * no scan of Polaris's own images means no line on the card.
 *
 * The newest scan per image (see `ownImageKey`) decides, so an image an update
 * already replaced (same reference, older id) is never counted for the one
 * running now: when the newest scan of a reference failed, that reference is reported
 * as not scanned rather than with an older image's numbers. Server-only.
 */

import { prisma } from "@polaris/db";
import { HostdClient } from "@polaris/hostd-client";

/** How old the newest scan may be and still be shown. */
const WINDOW_MS = 30 * 24 * 60 * 60_000;
/** Polaris's own images are read from this many newest scans. */
export const OWN_SCANS = 200;

export interface OwnImageScan {
    readonly label: string;
    /** The scan's stored input, which names the app a part of Polaris runs as. */
    readonly input?: string;
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

/**
 * What one of Polaris's own images is across its releases. Most are their
 * reference (`.../polaris-web:latest`), which an update keeps. A part of Polaris
 * that runs as an app - the camera relay - comes up under a new release tag on
 * every build, so it is the app its scan names, or each build would leave the
 * one it replaced behind as an image of its own. Pure.
 */
export function ownImageKey(row: { readonly label: string; readonly input?: string }): string {
    try {
        const part = (JSON.parse(row.input ?? "{}") as { part?: unknown } | null)?.part;
        if (typeof part === "string" && part) return `app:${part}`;
    } catch {
        // Not JSON: the reference decides.
    }
    return row.label;
}

/** Newest scan per image (see `ownImageKey`); `rows` arrive newest first. Pure. */
export function newestPerRef<T extends { label: string; input?: string }>(rows: readonly T[]): T[] {
    const seen = new Map<string, T>();
    for (const row of rows) {
        const key = ownImageKey(row);
        if (!seen.has(key)) seen.set(key, row);
    }
    return [...seen.values()];
}

/**
 * The image ids the containers on this machine run, stopped ones included, or
 * null when the daemon does not answer.
 *
 * An update replaces an image under a new reference as often as under the same
 * one - `traefik:v3.6` became `traefik:v3.7` - and the scan of the one it
 * replaced is still the newest of its reference. Without this it stayed on the
 * screen, and in the summary, for the whole window, counting vulnerabilities in
 * an image nothing runs any more.
 */
export async function runningImageIds(): Promise<ReadonlySet<string> | null> {
    const reply = await new HostdClient()
        .dockerRequest("GET", "/containers/json?all=1")
        .catch(() => null);
    if (!reply || reply.status !== 200) return null;
    try {
        const listing: unknown = JSON.parse(reply.body);
        if (!Array.isArray(listing)) return null;
        const ids = listing
            .map((row) => (row as { ImageID?: unknown } | null)?.ImageID)
            .filter((id): id is string => typeof id === "string" && id.length > 0);
        return new Set(ids);
    } catch {
        return null;
    }
}

/** The scans of an image this machine still runs; all of them when what it runs
 *  is not known, since hiding every image would say there is nothing to fix. Pure. */
export function ofRunningImages<T>(
    rows: readonly T[],
    imageIdOf: (row: T) => string | null,
    running: ReadonlySet<string> | null
): T[] {
    if (!running) return [...rows];
    return rows.filter((row) => {
        const id = imageIdOf(row);
        return id !== null && running.has(id);
    });
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
    for (const scan of scans) {
        const key = ownImageKey(scan);
        byRef.set(key, [...(byRef.get(key) ?? []), scan]);
    }
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
        select: {
            label: true,
            input: true,
            state: true,
            imageId: true,
            summary: true,
            finishedAt: true
        }
    });
    const running = await runningImageIds();
    return summarizeOwnScans(ofRunningImages(scans, (scan) => scan.imageId, running));
}
