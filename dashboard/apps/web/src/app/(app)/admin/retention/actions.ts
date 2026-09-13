"use server";

/**
 * Setting how long records are kept, and running the sweep on demand.
 *
 * Both are administrator-only and both are audited: a period that decides what
 * gets deleted is exactly the setting somebody should be able to see was changed,
 * and by whom.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/session";
import { setSetting } from "@/lib/setting-store";
import { recordAudit } from "@/lib/audit-service";
import { setRetentionPolicy, sweepRetention } from "@/lib/retention-service";
import { MAIL_BODY_KEEP_KEY, MAIL_BODY_KEEP_MAX, retentionPolicySchema } from "@polaris/core";

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

/**
 * How many messages are holding a body right now.
 *
 * Asked by the card rather than handed to it by the page, because no index
 * answers this: a held body is one of two nullable columns being set, over the
 * table that grows fastest here. Awaited in the page it was a scan of the whole
 * of MailMessage standing between somebody and the screen; asked from the card
 * it is a number that arrives a moment later, on a screen that is already up.
 *
 * Not audited: it reads a count and changes nothing.
 */
export async function mailBodyHeldAction(): Promise<{ held: number }> {
    await requireAdmin();
    return {
        held: await prisma.mailMessage.count({
            where: { OR: [{ bodyText: { not: null } }, { bodyHtml: { not: null } }] }
        })
    };
}

/**
 * How many messages of each mailbox keep their body.
 *
 * Audited like the periods above it, and for the same reason: it decides what
 * gets deleted - a smaller window is a sweep of held bodies on the next sync
 * pass - and the disk it frees is the kind of change somebody later wants to be
 * able to attribute.
 */
export async function saveMailBodyKeepAction(kept: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z
        .number()
        .int("Whole messages only.")
        .min(0, "Use 0 to fetch every message when it is opened.")
        .max(MAIL_BODY_KEEP_MAX, `That is more than ${MAIL_BODY_KEEP_MAX} messages.`)
        .safeParse(kept);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the number." };

    await setSetting(MAIL_BODY_KEEP_KEY, String(parsed.data));
    await recordAudit({
        actorId: admin.id,
        action: "settings.mail-body-keep",
        targetType: "setting",
        targetId: MAIL_BODY_KEEP_KEY,
        metadata: { kept: parsed.data }
    });
    revalidatePath("/admin/retention");
    return {};
}
