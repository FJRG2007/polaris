"use server";

/**
 * Changing where uploads are kept. An instance-wide decision, so it is an
 * administrator's to make.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setUploadSettings } from "@/lib/tasks/attachment-service";

const settingsSchema = z.object({
    /** A storage connection id, `local`, or `auto`. */
    target: z.string().trim().min(1).max(128),
    /** 1 MB to 10 GB. A limit outside that is a mistake rather than a policy. */
    maxBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(10 * 1024 * 1024 * 1024)
});

export async function setUploadSettingsAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = settingsSchema.safeParse(input);
    if (!parsed.success) return { error: "Check the settings and try again" };
    try {
        await setUploadSettings(parsed.data);
        await recordAudit({
            actorId: admin.id,
            action: "settings.uploads.update",
            targetType: "setting",
            targetId: "tasks.uploads",
            metadata: { target: parsed.data.target }
        });
        return {};
    } catch (caught) {
        console.error(caught);
        return { error: "Could not save that" };
    }
}
