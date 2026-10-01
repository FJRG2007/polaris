"use server";

/**
 * What the Connectivity screen can change: run a check now, and set how close
 * together two outages have to be to count as one. Administrators only.
 */

import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { checkConnectivityNow } from "@/lib/address-health";
import { MAX_MERGE_GAP_SECONDS, mergeGapSchema } from "@/lib/connectivity/outages";
import { setMergeGapSeconds } from "@/lib/connectivity/outage-tracker";

/** Probe now rather than waiting out the interval. The screen reloads the record
 *  once this answers. */
export async function checkConnectivityAction(): Promise<{ error?: string }> {
    await requireAdmin();
    try {
        await checkConnectivityNow();
        return {};
    } catch (error) {
        console.error("polaris: a connectivity check from the screen failed:", error);
        return { error: (await getTranslations("watch"))("connectivity.errors.check") };
    }
}

export async function setMergeGapAction(
    input: unknown
): Promise<{ seconds?: number; error?: string }> {
    await requireAdmin();
    const parsed = mergeGapSchema.safeParse(input);
    if (!parsed.success) {
        return {
            error: (await getTranslations("watch"))("connectivity.merge.invalid", {
                max: MAX_MERGE_GAP_SECONDS
            })
        };
    }
    await setMergeGapSeconds(parsed.data);
    return { seconds: parsed.data };
}
