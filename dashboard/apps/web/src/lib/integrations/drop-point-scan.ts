/**
 * Drop-point malware scanning. When a file lands in a drop point and the
 * VirusTotal integration is enabled with drop-point scanning on, this re-reads
 * the stored file, sends it to VirusTotal, records the verdict on the submission,
 * and notifies the drop point's owner if anything is flagged. It runs detached
 * from the upload response (fire-and-forget on the long-lived server) so the
 * uploader is never made to wait on a third-party scan, and every failure is
 * swallowed into a recorded "error" status rather than surfacing to the uploader.
 */

import { prisma } from "@polaris/db";
import { getEnabledCredential } from "@/lib/integration-service";
import { createNotification } from "@/lib/notification-service";
import { getDriverForConnection } from "@/lib/storage-service";
import { analyzeFile, VT_MAX_FILE_BYTES, type VtVerdict } from "./virustotal";

/** What the drop-point scan needs to know about a stored submission. */
export interface ScanTarget {
    submissionId: string;
    ownerId: string;
    connectionId: string;
    storedPath: string;
    fileName: string;
    size: number;
}

/** Read a driver stream fully into a Buffer (bounded by the caller's size check). */
async function readAll(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const chunks: Uint8Array[] = [];
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return Buffer.concat(chunks);
}

/** Record the scan outcome on the submission row. */
async function setStatus(
    submissionId: string,
    scanStatus: string,
    result?: Record<string, unknown>
): Promise<void> {
    await prisma.fileRequestSubmission.update({
        where: { id: submissionId },
        data: { scanStatus, scanResult: result ? JSON.stringify(result) : null }
    });
}

/** A compact, storable summary of a VirusTotal verdict. */
function summarize(verdict: VtVerdict): Record<string, unknown> {
    return {
        provider: "virustotal",
        malicious: verdict.malicious,
        suspicious: verdict.suspicious,
        harmless: verdict.harmless,
        undetected: verdict.undetected,
        permalink: verdict.permalink,
        completed: verdict.completed
    };
}

/**
 * Scan one stored submission, if VirusTotal is configured to scan drop points.
 * Safe to call unconditionally after storing a file; it returns quietly when the
 * integration is off. Never throws - failures are recorded as an "error" status.
 */
export async function scanDropPointSubmission(target: ScanTarget): Promise<void> {
    const integration = await getEnabledCredential("virustotal");
    if (!integration || integration.config.scanDropPoints === false) return;

    const maxBytes =
        typeof integration.config.maxScanBytes === "number"
            ? Math.min(integration.config.maxScanBytes, VT_MAX_FILE_BYTES)
            : VT_MAX_FILE_BYTES;

    try {
        if (target.size > maxBytes) {
            await setStatus(target.submissionId, "skipped", {
                provider: "virustotal",
                reason: "too_large",
                maxBytes
            });
            return;
        }

        await setStatus(target.submissionId, "pending");

        const driver = await getDriverForConnection(target.connectionId);
        let bytes: Buffer;
        try {
            bytes = await readAll(await driver.readStream(target.storedPath));
        } finally {
            await driver.dispose();
        }

        const verdict = await analyzeFile(integration.credential, target.fileName, bytes);
        const flagged = verdict.malicious > 0 || verdict.suspicious > 0;
        await setStatus(target.submissionId, flagged ? "malicious" : verdict.completed ? "clean" : "pending", summarize(verdict));

        if (flagged) {
            await createNotification({
                userId: target.ownerId,
                type: "security.malware",
                title: "Malware detected in a drop-point upload",
                body: `"${target.fileName}" was flagged by ${verdict.malicious} engine(s) on VirusTotal.`,
                data: {
                    fileName: target.fileName,
                    malicious: verdict.malicious,
                    suspicious: verdict.suspicious,
                    permalink: verdict.permalink,
                    href: "/requests"
                }
            });
        }
    } catch (error) {
        await setStatus(target.submissionId, "error", {
            provider: "virustotal",
            reason: error instanceof Error ? error.message : "scan_failed"
        }).catch(() => undefined);
    }
}
