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
import { readVirusTotalConfig, type ScanAction } from "@/lib/integrations/registry";
import { lookupBySha256, uploadAndScan, VT_MAX_UPLOAD_BYTES, type VtVerdict } from "@/lib/integrations/virustotal";
import { createNotification, type NotificationLevel } from "@/lib/notification-service";

/** Folder (per connection root) flagged files are moved into on quarantine. */
const QUARANTINE_DIR = ".polaris-quarantine";

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
function buildAlert(request: ScanRequest, verdict: VtVerdict, action: ScanOutcome["action"]): Alert {
    const engines = verdict.malicious + verdict.suspicious;
    const where = `"${request.fileName}" uploaded to "${request.dropPointTitle}"`;
    if (verdict.kind === "malicious" || verdict.kind === "suspicious") {
        const tail =
            action === "blocked"
                ? "The upload was blocked and removed."
                : action === "quarantined"
                  ? "It was moved to quarantine."
                  : "It was kept - review it before opening.";
        return {
            level: verdict.kind === "malicious" ? "danger" : "warning",
            title: verdict.kind === "malicious" ? "Malicious upload detected" : "Suspicious upload detected",
            body: `${where} was flagged by VirusTotal (${engines} engine${engines === 1 ? "" : "s"}). ${tail}`
        };
    }
    if (verdict.kind === "clean") {
        return { level: "success", title: "Upload scanned clean", body: `${where} passed the VirusTotal scan.` };
    }
    return {
        level: "info",
        title: "Upload could not be fully scanned",
        body: `${where} could not be scanned (${verdict.detail ?? "scanner unavailable"}). It was kept.`
    };
}

/**
 * Scan one stored drop-point upload and enforce the configured action. Returns
 * whether the upload must be rejected. Any failure fails open (keeps the file).
 */
export async function scanDropPointUpload(request: ScanRequest): Promise<ScanOutcome> {
    let state;
    try {
        state = await getIntegrationState("virustotal");
    } catch {
        return SKIPPED;
    }
    if (!state?.enabled) return SKIPPED;
    const config = readVirusTotalConfig(state.config);
    if (!config.scanDropPoints) return SKIPPED;
    const apiKey = await getIntegrationSecret("virustotal");
    if (!apiKey) return SKIPPED;

    let verdict: VtVerdict;
    try {
        const collect = request.size <= VT_MAX_UPLOAD_BYTES;
        const { sha256, bytes } = await hashStream(await request.driver.readStream(request.storedPath), collect);
        const known = await lookupBySha256(apiKey, sha256);
        if (known) verdict = known;
        else if (bytes) verdict = await uploadAndScan(apiKey, bytes, sha256);
        else verdict = { kind: "unknown", malicious: 0, suspicious: 0, detail: "File exceeds the 32 MB scan limit" };
        return await enforce(request, verdict, config.onDetection, sha256);
    } catch (caught) {
        // Scanner failure: fail open, but still tell the owner it did not complete.
        const detail = caught instanceof Error ? caught.message : "scan failed";
        await recordScan(request, { kind: "error", malicious: 0, suspicious: 0, detail }, "none", null);
        await createNotification({
            userId: request.ownerId,
            type: "scan.error",
            level: "info",
            title: "Upload could not be scanned",
            body: `"${request.fileName}" uploaded to "${request.dropPointTitle}" could not be scanned (${detail}). It was kept.`,
            href: "/requests",
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
    sha256: string
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
        const alert = buildAlert(request, verdict, action);
        await createNotification({
            userId: request.ownerId,
            type: `scan.${verdict.kind}`,
            level: alert.level,
            title: alert.title,
            body: alert.body,
            href: verdict.permalink ?? "/requests",
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
