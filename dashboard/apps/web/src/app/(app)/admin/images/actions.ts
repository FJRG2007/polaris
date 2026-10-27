"use server";

/**
 * Management > Polaris images. Administrators only, checked on every call as
 * the page checks it; errors come back as a key of the `imageScans` catalog.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import {
    ownImageFindings,
    ownImages,
    queueOwnImageScan,
    type ImageFindingRow,
    type OwnImage,
    type QueueRefusal
} from "@/lib/security/image-findings";

const scanId = z.string().uuid();

export async function ownImagesAction(): Promise<{ images: OwnImage[] } | { error: "failed" }> {
    await requireAdmin();
    try {
        return { images: await ownImages() };
    } catch (caught) {
        console.error("polaris: Polaris's own image scans could not be read:", caught);
        return { error: "failed" };
    }
}

export async function ownImageFindingsAction(
    input: unknown
): Promise<{ findings: ImageFindingRow[] } | { error: "failed" | "notFound" }> {
    await requireAdmin();
    const id = scanId.safeParse(input);
    if (!id.success) return { error: "notFound" };
    try {
        const findings = await ownImageFindings(id.data);
        return findings ? { findings } : { error: "notFound" };
    } catch (caught) {
        console.error("polaris: an own image scan's findings could not be read:", caught);
        return { error: "failed" };
    }
}

export async function scanOwnImageAction(
    input: unknown
): Promise<{ scanId: string } | { error: QueueRefusal | "failed" }> {
    const user = await requireAdmin();
    const id = scanId.safeParse(input);
    if (!id.success) return { error: "notFound" };
    try {
        const result = await queueOwnImageScan(id.data, user.id);
        return "refused" in result ? { error: result.refused } : result;
    } catch (caught) {
        console.error("polaris: an own image scan could not be queued:", caught);
        return { error: "failed" };
    }
}
