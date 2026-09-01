"use server";

/**
 * Setting how long records are kept, and running the sweep on demand.
 *
 * Both are administrator-only and both are audited: a period that decides what
 * gets deleted is exactly the setting somebody should be able to see was changed,
 * and by whom.
 */

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { retentionPolicySchema } from "@polaris/core";
import { setRetentionPolicy, sweepRetention } from "@/lib/retention-service";

export async function saveRetentionAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = retentionPolicySchema.safeParse(input);
    if (!parsed.success) return { error: "That is not a period Polaris offers" };

    await setRetentionPolicy(parsed.data);
    await recordAudit({
        actorId: admin.id,
        action: "retention.set",
        targetType: "instance",
        metadata: { ...parsed.data }
    });
    revalidatePath("/admin/retention");
    return {};
}

/**
 * Run a pass now.
 *
 * The schedule already does this, so the button is for the operator who has just
 * shortened a period and wants to see the number move rather than wait an hour
 * to find out whether it worked. One pass is bounded, so pressing it on a
 * deployment with a year of history takes a bite rather than the lot - which is
 * what `more` says.
 */
export async function sweepRetentionAction(): Promise<{
    removed?: number;
    more?: boolean;
    error?: string;
}> {
    const admin = await requireAdmin();
    try {
        const result = await sweepRetention();
        const removed = result.notifications + result.activity + result.audit;
        // Audited only when it actually took something. A pass that found nothing
        // due is not an event, and writing one would be this feature filling the
        // table it exists to bound.
        if (removed > 0) {
            await recordAudit({
                actorId: admin.id,
                action: "retention.sweep",
                targetType: "instance",
                metadata: { ...result }
            });
        }
        revalidatePath("/admin/retention");
        return { removed, more: result.more };
    } catch (error) {
        console.error("polaris: the retention sweep failed:", error);
        return { error: "That could not be run just now" };
    }
}
