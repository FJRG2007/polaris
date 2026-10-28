/**
 * Image vulnerability findings where they are acted on: a Deploy service's
 * Vulnerabilities tab (the image it runs now) and Management > Polaris images
 * (the images Polaris itself runs on this machine). Read straight from the
 * scans' tables, as `dependency-findings.ts` does - the dashboard never imports
 * the security scans app. A scan asked for here is a queued row; the scans'
 * own job starts it within a minute, under the same rules as one queued there.
 *
 * Server-only. The caller checks that the reader may see the service, or is
 * an administrator.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { newestPerRef, OWN_SCANS, ownScansWhere } from "./own-images";

/** One scan's stored findings are capped at this by the scans themselves. */
const MAX_FINDINGS = 500;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export type Counted = "critical" | "high" | "medium" | "low";
export type ScanState = "queued" | "running" | "done" | "failed";

export interface ImageScanView {
    readonly id: string;
    readonly state: ScanState;
    /** A message key of the scans (`notRunning`, `imageMissing`, ...), never raw output. */
    readonly error: string | null;
    readonly createdAt: string;
    readonly finishedAt: string | null;
    readonly counts: Readonly<Record<Counted, number>>;
    readonly total: number;
}

export interface ImageFindingRow {
    readonly id: string;
    readonly severity: string;
    readonly title: string;
    readonly location: string;
    readonly fixedIn: string | null;
    readonly url: string | null;
    readonly layer: string | null;
}

const stateSchema = z.enum(["queued", "running", "done", "failed"]);
const countSchema = z.number().int().nonnegative().catch(0).default(0);
const summarySchema = z.object({
    critical: countSchema,
    high: countSchema,
    medium: countSchema,
    low: countSchema,
    total: countSchema
});

function json(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

/** A stored scan row as the screens show it; null for a state this code does not know. Pure. */
export function scanView(row: {
    id: string;
    state: string;
    error: string | null;
    summary: string;
    createdAt: Date;
    finishedAt: Date | null;
}): ImageScanView | null {
    const state = stateSchema.safeParse(row.state);
    if (!state.success) return null;
    const summary = summarySchema.safeParse(json(row.summary) ?? {});
    const counts = summary.success
        ? summary.data
        : { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
    return {
        id: row.id,
        state: state.data,
        error: row.error && /^[A-Za-z]{1,40}$/.test(row.error) ? row.error : null,
        createdAt: row.createdAt.toISOString(),
        finishedAt: row.finishedAt?.toISOString() ?? null,
        counts: {
            critical: counts.critical,
            high: counts.high,
            medium: counts.medium,
            low: counts.low
        },
        total: counts.total
    };
}

const SCAN_SELECT = {
    id: true,
    state: true,
    error: true,
    summary: true,
    createdAt: true,
    finishedAt: true
} as const;

async function findingsOf(scanId: string): Promise<ImageFindingRow[]> {
    const rows = await prisma.securityFinding.findMany({
        where: { scanId },
        orderBy: { position: "asc" },
        take: MAX_FINDINGS,
        select: {
            id: true,
            severity: true,
            title: true,
            location: true,
            fixedIn: true,
            url: true,
            layer: true
        }
    });
    // An advisory link is only ever an https one.
    return rows.map((row) => ({ ...row, url: row.url?.startsWith("https://") ? row.url : null }));
}

/* -------------------------------------------------------------------------- */
/* A Deploy service                                                            */
/* -------------------------------------------------------------------------- */

/** The image a service runs now: its newest running deployment's. */
async function runningImage(applicationId: string): Promise<string | null> {
    const row = await prisma.deployment.findFirst({
        where: {
            deployableType: "application",
            deployableId: applicationId,
            status: "running",
            imageTag: { not: null }
        },
        orderBy: { createdAt: "desc" },
        select: { imageTag: true }
    });
    return row?.imageTag ?? null;
}

/**
 * What the scans say about the image a service runs: the newest image scan of
 * the image reference it runs now, whether this service's or one the server's
 * own listing queued - the same match the deploy check reads. A service that
 * runs nothing shows its own newest scan.
 */
export async function serviceImageFindings(applicationId: string): Promise<{
    image: string | null;
    scan: ImageScanView | null;
    findings: ImageFindingRow[];
}> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { targetId: true }
    });
    if (!app) return { image: null, scan: null, findings: [] };
    const image = await runningImage(applicationId);
    const row = await prisma.securityScan.findFirst({
        where: {
            targetId: app.targetId,
            kind: "image",
            input: { contains: JSON.stringify(image ?? applicationId) }
        },
        orderBy: { createdAt: "desc" },
        select: SCAN_SELECT
    });
    const scan = row ? scanView(row) : null;
    const findings = scan?.state === "done" ? await findingsOf(scan.id) : [];
    return { image, scan, findings };
}

/** Why a scan could not be queued, as a key of the screen's catalog. */
export type QueueRefusal = "notFound" | "notRunning";

/**
 * Queue a scan of the image a service runs now. A scan already waiting or
 * running for it is answered instead of a second one.
 */
export async function queueServiceImageScan(
    applicationId: string,
    userId: string
): Promise<{ scanId: string } | { refused: QueueRefusal }> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { targetId: true, name: true }
    });
    if (!app) return { refused: "notFound" };
    const image = await runningImage(applicationId);
    if (!image) return { refused: "notRunning" };
    const pending = await prisma.securityScan.findFirst({
        where: {
            targetId: app.targetId,
            kind: "image",
            state: { in: ["queued", "running"] },
            AND: [
                { input: { contains: JSON.stringify(applicationId) } },
                { input: { contains: JSON.stringify(image) } }
            ]
        },
        select: { id: true }
    });
    if (pending) return { scanId: pending.id };
    // The same input the scans write for an app's image (see their `queueImage`).
    const created = await prisma.securityScan.create({
        data: {
            targetId: app.targetId,
            kind: "image",
            label: app.name,
            input: JSON.stringify({ applicationId, image }),
            requestedById: userId
        },
        select: { id: true }
    });
    return { scanId: created.id };
}

/* -------------------------------------------------------------------------- */
/* Polaris's own images                                                        */
/* -------------------------------------------------------------------------- */

export interface OwnImage {
    /** The reference the image runs under: `ghcr.io/.../dashboard:1.2.3`. */
    readonly ref: string;
    readonly imageId: string | null;
    /** The Polaris parts that run it: `web`, `hostd`. */
    readonly users: readonly string[];
    readonly scan: ImageScanView;
}

const ownInputSchema = z.object({
    imageId: z.string().regex(IMAGE_ID).nullable().catch(null).default(null),
    ref: z.string().max(512).nullable().catch(null).default(null),
    users: z.array(z.string().max(200)).max(20).catch([]).default([]),
    applicationIds: z.array(z.string().max(64)).max(20).catch([]).default([]),
    part: z.string().min(1).max(64).nullable().catch(null).default(null)
});

function ownInput(raw: string): z.infer<typeof ownInputSchema> {
    const parsed = ownInputSchema.safeParse(json(raw) ?? {});
    return parsed.success
        ? parsed.data
        : { imageId: null, ref: null, users: [], applicationIds: [], part: null };
}

/**
 * Polaris's own images on this machine, each with its newest scan, worst first.
 * Only references scanned within the same window the Settings summary counts,
 * so an image an update replaced drops off as the summary drops it.
 */
export async function ownImages(now = new Date()): Promise<OwnImage[]> {
    const rows = await prisma.securityScan.findMany({
        where: ownScansWhere(now),
        orderBy: { createdAt: "desc" },
        take: OWN_SCANS,
        select: { ...SCAN_SELECT, label: true, input: true, imageId: true }
    });
    const out: OwnImage[] = [];
    for (const row of newestPerRef(rows)) {
        const scan = scanView(row);
        if (!scan) continue;
        const input = ownInput(row.input);
        out.push({
            ref: input.ref ?? row.label,
            imageId: row.imageId ?? input.imageId,
            users: input.users,
            scan
        });
    }
    return out.sort(
        (a, b) =>
            b.scan.counts.critical - a.scan.counts.critical ||
            b.scan.counts.high - a.scan.counts.high ||
            a.ref.localeCompare(b.ref)
    );
}

/** The image reference one of Polaris's own scans was of; null when it is not one of those. */
export async function ownScanRef(scanId: string): Promise<string | null> {
    const scan = await prisma.securityScan.findFirst({
        where: { id: scanId, source: "polaris", kind: "image", target: { kind: "local" } },
        select: { label: true, input: true }
    });
    return scan ? (ownInput(scan.input).ref ?? scan.label) : null;
}

/** One of Polaris's own scans' findings; null when the scan is not one of those. */
export async function ownImageFindings(scanId: string): Promise<ImageFindingRow[] | null> {
    const scan = await prisma.securityScan.findFirst({
        where: { id: scanId, source: "polaris", kind: "image", target: { kind: "local" } },
        select: { id: true, state: true }
    });
    if (!scan) return null;
    return scan.state === "done" ? findingsOf(scan.id) : [];
}

/**
 * Scan one of Polaris's own images again: the image a stored scan of it named,
 * by its id - never one the screen sends. An image an update has since removed
 * fails as missing, and the scans' own job picks up the new one.
 */
export async function queueOwnImageScan(
    scanId: string,
    userId: string
): Promise<{ scanId: string } | { refused: QueueRefusal }> {
    const scan = await prisma.securityScan.findFirst({
        where: { id: scanId, source: "polaris", kind: "image", target: { kind: "local" } },
        select: { targetId: true, label: true, input: true, imageId: true }
    });
    const input = scan ? ownInput(scan.input) : null;
    const imageId = scan?.imageId ?? input?.imageId ?? null;
    if (!scan || !input || !imageId || !IMAGE_ID.test(imageId)) return { refused: "notFound" };
    const pending = await prisma.securityScan.findFirst({
        where: { targetId: scan.targetId, imageId, state: { in: ["queued", "running"] } },
        select: { id: true }
    });
    if (pending) return { scanId: pending.id };
    const created = await prisma.securityScan.create({
        data: {
            targetId: scan.targetId,
            kind: "image",
            label: scan.label,
            // The app a part of Polaris runs as is kept, so the rescan stays the
            // same image as the scan it repeats (see `ownImageKey`).
            input: JSON.stringify({
                imageId,
                ref: input.ref ?? scan.label,
                users: input.users,
                ...(input.applicationIds.length > 0
                    ? { applicationIds: input.applicationIds }
                    : {}),
                ...(input.part ? { part: input.part } : {})
            }),
            requestedById: userId,
            imageId,
            source: "polaris"
        },
        select: { id: true }
    });
    return { scanId: created.id };
}
