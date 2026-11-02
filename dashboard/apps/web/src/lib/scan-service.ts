/**
 * Drop-point upload scanning. When the VirusTotal integration is enabled, every
 * file dropped into a drop point is scanned before the upload is acknowledged
 * (so the configured action - block, quarantine, or notify - can be enforced
 * before a flagged file is handed back as "received"). The file is read back from
 * storage to hash it; a hash lookup is tried first and only an unknown file under
 * the Public API limit is uploaded. The drop point's owner is always alerted with
 * the verdict through the notification system. Scanning never throws to the upload
 * path: a scanner failure fails open (the file is kept) with an alert, so an
 * unreachable VirusTotal cannot silently reject legitimate uploads.
 */

import { createHash } from "node:crypto";
import { baseName, normalizeRelPath } from "@polaris/core";
import { prisma } from "@polaris/db";
import type { StorageDriver } from "@polaris/storage";
import { getIntegrationState, getIntegrationSecret } from "@/lib/integration-service";
import { getDriverForConnection } from "@/lib/storage-service";
import { readVirusTotalConfig, type ScanAction } from "@/lib/integrations/registry";
import {
    lookupBySha256,
    SCAN_SHARE,
    uploadAndScan,
    VT_MAX_UPLOAD_BYTES,
    type VtVerdict
} from "@/lib/integrations/virustotal";
import { takeServedLookup } from "@/lib/integrations/provider-pause";
import { notify } from "@/lib/notifications/dispatch";
import { wordsFor } from "@/lib/notifications/notice-words";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import type { NotificationLevel } from "@/lib/notification-service";
import { QUARANTINE_DIR } from "@/lib/system-paths";

export interface ScanOutcome {
    /** Whether a scan actually ran (false when the integration is off/misconfigured). */
    scanned: boolean;
    /** True when the upload must be rejected (block action on a detection). */
    blocked: boolean;
    verdict: "clean" | "suspicious" | "malicious" | "unknown" | "error" | "skipped";
    action: "none" | "blocked" | "quarantined" | "notified";
    detail?: string;
}

const SKIPPED: ScanOutcome = { scanned: false, blocked: false, verdict: "skipped", action: "none" };

/** Paused, or past the part of the budget scans may use. The file is kept and
 *  scanned once there are requests again. */
const NOT_ASKED: VtVerdict = {
    kind: "unknown",
    malicious: 0,
    suspicious: 0,
    detail: "VirusTotal is not taking requests right now",
    deferred: true
};

/** Scans waiting for requests, taken a few at a time from the oldest attempt. */
const PENDING_BATCH = 3;
const PENDING_EVERY_MS = 60 * 1000;
/** A longer wait than any outage worth waiting for, so the owner is told in the end. */
const PENDING_GIVE_UP_MS = 7 * 24 * 60 * 60 * 1000;

export interface ScanRequest {
    driver: StorageDriver;
    connectionId: string;
    /** Where the file was stored (its final path in the destination). */
    storedPath: string;
    /** The uploader's original file name, for the alert. */
    fileName: string;
    /** The drop point owner who gets alerted. */
    ownerId: string;
    dropPointTitle: string;
    submissionId: string;
    size: number;
}

/** Read a stream to its SHA-256, optionally collecting the bytes for upload. */
async function hashStream(
    stream: ReadableStream<Uint8Array>,
    collect: boolean
): Promise<{ sha256: string; bytes: Uint8Array | null }> {
    const hash = createHash("sha256");
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            hash.update(value);
            if (collect) {
                chunks.push(value);
                total += value.byteLength;
            }
        }
    } finally {
        reader.releaseLock();
    }
    if (!collect) return { sha256: hash.digest("hex"), bytes: null };
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return { sha256: hash.digest("hex"), bytes };
}

/** The hash lookup, then an upload if the file is unknown and small enough. */
async function askVirusTotal(
    apiKey: string,
    sha256: string,
    bytes: Uint8Array | null
): Promise<VtVerdict> {
    if (!(await takeServedLookup("virustotal", SCAN_SHARE))) return NOT_ASKED;
    const known = await lookupBySha256(apiKey, sha256);
    if (known) return known;
    if (!bytes)
        return {
            kind: "unknown",
            malicious: 0,
            suspicious: 0,
            detail: "File exceeds the 32 MB scan limit"
        };
    if (!(await takeServedLookup("virustotal", SCAN_SHARE))) return NOT_ASKED;
    return uploadAndScan(apiKey, bytes, sha256);
}

/** Move a flagged file into the connection's quarantine folder; returns its new path. */
async function quarantine(driver: StorageDriver, storedPath: string): Promise<string> {
    const target = normalizeRelPath(`${QUARANTINE_DIR}/${baseName(storedPath)}`);
    try {
        await driver.mkdir(QUARANTINE_DIR);
    } catch {
        // Already exists (or the backend makes parents implicitly); ignore.
    }
    await driver.move(storedPath, target);
    return target;
}

interface Alert {
    level: NotificationLevel;
    title: string;
    body: string;
}

/** Compose the owner's alert for a completed scan. */
function buildAlert(
    t: NamespaceTranslator<"notices">,
    request: ScanRequest,
    verdict: VtVerdict,
    action: ScanOutcome["action"]
): Alert {
    const engines = verdict.malicious + verdict.suspicious;
    const where = { file: request.fileName, dropPoint: request.dropPointTitle };
    if (verdict.kind === "malicious" || verdict.kind === "suspicious") {
        const tail =
            action === "blocked"
                ? t("scan.blocked")
                : action === "quarantined"
                  ? t("scan.quarantined")
                  : t("scan.kept");
        return {
            level: verdict.kind === "malicious" ? "danger" : "warning",
            title:
                verdict.kind === "malicious" ? t("scan.maliciousTitle") : t("scan.suspiciousTitle"),
            body: t("scan.flagged", { ...where, engines, tail })
        };
    }
    if (verdict.kind === "clean") {
        return { level: "success", title: t("scan.cleanTitle"), body: t("scan.clean", where) };
    }
    return {
        level: "info",
        title: t("scan.partialTitle"),
        body: t("scan.notScanned", { ...where, detail: verdict.detail ?? t("scan.unavailable") })
    };
}

/** The key and the action, or null when drop points are not being scanned. */
async function scanSettings(): Promise<{ apiKey: string; onDetection: ScanAction } | null> {
    let state;
    try {
        state = await getIntegrationState("virustotal");
    } catch {
        return null;
    }
    if (!state?.enabled) return null;
    const config = readVirusTotalConfig(state.config);
    if (!config.scanDropPoints) return null;
    const apiKey = await getIntegrationSecret("virustotal");
    return apiKey ? { apiKey, onDetection: config.onDetection } : null;
}

/**
 * Scan one stored drop-point upload and enforce the configured action. Returns
 * whether the upload must be rejected. Any failure fails open (keeps the file).
 */
export async function scanDropPointUpload(request: ScanRequest): Promise<ScanOutcome> {
    const settings = await scanSettings();
    if (!settings) return SKIPPED;
    const { apiKey, onDetection } = settings;

    try {
        const collect = request.size <= VT_MAX_UPLOAD_BYTES;
        const { sha256, bytes } = await hashStream(
            await request.driver.readStream(request.storedPath),
            collect
        );
        const verdict = await askVirusTotal(apiKey, sha256, bytes);
        if (verdict.deferred) {
            await prisma.fileScan.create({
                data: {
                    provider: "virustotal",
                    submissionId: request.submissionId,
                    connectionId: request.connectionId,
                    path: request.storedPath,
                    sha256,
                    verdict: "pending",
                    detail: verdict.detail ?? null
                }
            });
            return {
                scanned: true,
                blocked: false,
                verdict: "unknown",
                action: "none",
                detail: verdict.detail
            };
        }
        return await enforce(request, verdict, onDetection, sha256);
    } catch (caught) {
        // Scanner failure: fail open, but still tell the owner it did not complete.
        const detail = caught instanceof Error ? caught.message : "scan failed";
        await recordScan(
            request,
            { kind: "error", malicious: 0, suspicious: 0, detail },
            "none",
            null
        );
        const t = await wordsFor(request.ownerId, "notices");
        await notify({
            userId: request.ownerId,
            event: "scan.error",
            title: t("scan.failedTitle"),
            body: t("scan.notScanned", {
                file: request.fileName,
                dropPoint: request.dropPointTitle,
                detail
            }),
            href: "/drive/drop-points",
            metadata: { connectionId: request.connectionId, submissionId: request.submissionId }
        });
        return { scanned: true, blocked: false, verdict: "error", action: "none", detail };
    }
}

/** Apply the configured action for a verdict, persist it, and alert the owner. */
async function enforce(
    request: ScanRequest,
    verdict: VtVerdict,
    onDetection: ScanAction,
    sha256: string | null
): Promise<ScanOutcome> {
    const detected = verdict.kind === "malicious" || verdict.kind === "suspicious";
    let action: ScanOutcome["action"] = detected ? "notified" : "none";
    let blocked = false;

    if (detected && onDetection === "block") {
        try {
            await request.driver.delete(request.storedPath, { recursive: false });
        } catch {
            // If removal fails the record still reflects the block decision.
        }
        await prisma.fileRequestSubmission.updateMany({
            where: { id: request.submissionId },
            data: { status: "blocked" }
        });
        action = "blocked";
        blocked = true;
    } else if (detected && onDetection === "quarantine") {
        try {
            const target = await quarantine(request.driver, request.storedPath);
            await prisma.fileRequestSubmission.updateMany({
                where: { id: request.submissionId },
                data: { status: "quarantined", storedPath: target }
            });
            action = "quarantined";
        } catch {
            action = "notified"; // Could not move it; leave it and just alert.
        }
    }

    await recordScan(request, verdict, action, sha256);
    // Alert the owner on anything actionable - a detection or a scan that could not
    // complete - but stay quiet on a clean pass so drop points do not spam the bell.
    if (verdict.kind !== "clean") {
        const alert = buildAlert(
            await wordsFor(request.ownerId, "notices"),
            request,
            verdict,
            action
        );
        // One event covers every non-clean verdict; the verdict itself rides in
        // the metadata and sets the severity, so a rule is "tell me when a drop
        // point catches something" rather than one rule per verdict word.
        await notify({
            userId: request.ownerId,
            event: verdict.kind === "error" ? "scan.error" : "scan.detection",
            level: alert.level,
            title: alert.title,
            body: alert.body,
            actionRequired: detected,
            href: verdict.permalink ?? "/drive/drop-points",
            metadata: {
                connectionId: request.connectionId,
                submissionId: request.submissionId,
                verdict: verdict.kind,
                permalink: verdict.permalink ?? null
            }
        });
    }

    const kind = verdict.kind === "error" ? "error" : verdict.kind;
    return { scanned: true, blocked, verdict: kind, action, detail: verdict.detail };
}

interface PendingScan {
    id: string;
    submissionId: string | null;
    connectionId: string | null;
    sha256: string | null;
    createdAt: Date;
}

/** Try one waiting scan. False when VirusTotal still has no requests to give, which
 *  goes for every other waiting file too. */
async function finishPendingScan(
    pending: PendingScan,
    settings: { apiKey: string; onDetection: ScanAction }
): Promise<boolean> {
    const submission = pending.submissionId
        ? await prisma.fileRequestSubmission.findUnique({
              where: { id: pending.submissionId },
              select: {
                  fileName: true,
                  storedPath: true,
                  size: true,
                  request: { select: { ownerId: true, title: true } }
              }
          })
        : null;
    if (!submission || !pending.submissionId || !pending.connectionId) {
        await prisma.fileScan.deleteMany({ where: { id: pending.id } });
        return true;
    }
    const again = () =>
        prisma.fileScan.update({ where: { id: pending.id }, data: { updatedAt: new Date() } });

    let driver: StorageDriver | undefined;
    try {
        driver = await getDriverForConnection(pending.connectionId);
        const request: ScanRequest = {
            driver,
            connectionId: pending.connectionId,
            storedPath: submission.storedPath,
            fileName: submission.fileName,
            ownerId: submission.request.ownerId,
            dropPointTitle: submission.request.title,
            submissionId: pending.submissionId,
            size: Number(submission.size)
        };
        const gaveUp = Date.now() - pending.createdAt.getTime() > PENDING_GIVE_UP_MS;
        if (gaveUp) {
            await prisma.fileScan.deleteMany({ where: { id: pending.id } });
            await enforce(
                request,
                { ...NOT_ASKED, deferred: false },
                settings.onDetection,
                pending.sha256
            );
            return true;
        }
        const { sha256, bytes } = await hashStream(
            await driver.readStream(submission.storedPath),
            request.size <= VT_MAX_UPLOAD_BYTES
        );
        const verdict = await askVirusTotal(settings.apiKey, sha256, bytes);
        if (verdict.deferred) {
            await again();
            return false;
        }
        await prisma.fileScan.deleteMany({ where: { id: pending.id } });
        await enforce(request, verdict, settings.onDetection, sha256);
        return true;
    } catch (caught) {
        // Its storage may simply be away. The next pass tries the others first.
        console.error("polaris: a waiting scan failed:", (caught as Error | null)?.name);
        await again();
        return true;
    } finally {
        await driver?.dispose();
    }
}

/** Scan the files that arrived while VirusTotal had no requests left. */
export async function finishPendingScans(): Promise<void> {
    const settings = await scanSettings();
    if (!settings) return;
    const pending = await prisma.fileScan.findMany({
        where: {
            verdict: "pending",
            updatedAt: { lt: new Date(Date.now() - PENDING_EVERY_MS) }
        },
        orderBy: { updatedAt: "asc" },
        take: PENDING_BATCH,
        select: {
            id: true,
            submissionId: true,
            connectionId: true,
            sha256: true,
            createdAt: true
        }
    });
    for (const scan of pending) {
        if (!(await finishPendingScan(scan, settings))) return;
    }
}

/** Keep trying, one pass at a time: a pass can outlast the interval. */
export function startPendingScans(): void {
    let running = false;
    setInterval(() => {
        if (running) return;
        running = true;
        void finishPendingScans()
            .catch((caught: unknown) => {
                console.error("polaris: waiting scans failed:", (caught as Error | null)?.name);
            })
            .finally(() => {
                running = false;
            });
    }, PENDING_EVERY_MS).unref?.();
}

/** Persist a scan result for the owner's audit trail. */
async function recordScan(
    request: ScanRequest,
    verdict: VtVerdict,
    action: ScanOutcome["action"],
    sha256: string | null
): Promise<void> {
    try {
        await prisma.fileScan.create({
            data: {
                provider: "virustotal",
                submissionId: request.submissionId,
                connectionId: request.connectionId,
                path: request.storedPath,
                sha256,
                verdict: verdict.kind,
                malicious: verdict.malicious,
                suspicious: verdict.suspicious,
                permalink: verdict.permalink ?? null,
                action,
                detail: verdict.detail ?? null
            }
        });
    } catch {
        // The scan record is best-effort; never fail the upload over it.
    }
}
