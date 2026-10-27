"use server";

/**
 * A service's image findings, for its Vulnerabilities tab. Reading them asks
 * what seeing the project asks; scanning again asks what deploying it asks,
 * since a scan exports the running image on its server. Errors come back as a
 * key of the tab's catalog, never as a host path or a daemon's words.
 */

import { z } from "zod";
import { requirePermission } from "@/lib/session";
import { requireApplicationAccess } from "@/lib/deploy-project-access";
import {
    queueServiceImageScan,
    serviceImageFindings,
    type ImageFindingRow,
    type ImageScanView,
    type QueueRefusal
} from "@/lib/security/image-findings";

const idSchema = z.string().uuid();

export async function serviceImageFindingsAction(applicationId: unknown): Promise<
    | { error: "failed" }
    | { image: string | null; scan: ImageScanView | null; findings: ImageFindingRow[] }
> {
    const user = await requirePermission("deploy.read");
    const id = idSchema.safeParse(applicationId);
    if (!id.success) return { error: "failed" };
    try {
        await requireApplicationAccess(id.data, user.id, "project.read");
        return await serviceImageFindings(id.data);
    } catch (caught) {
        console.error("polaris: a service's image findings could not be read:", caught);
        return { error: "failed" };
    }
}

export async function scanServiceImageAction(
    applicationId: unknown
): Promise<{ scanId: string } | { error: QueueRefusal | "failed" }> {
    const user = await requirePermission("deploy.read");
    const id = idSchema.safeParse(applicationId);
    if (!id.success) return { error: "failed" };
    try {
        await requireApplicationAccess(id.data, user.id, "deploy.run");
        const result = await queueServiceImageScan(id.data, user.id);
        return "refused" in result ? { error: result.refused } : result;
    } catch (caught) {
        console.error("polaris: a service's image scan could not be queued:", caught);
        return { error: "failed" };
    }
}
