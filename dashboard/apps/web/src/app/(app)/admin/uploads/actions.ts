"use server";

/**
 * Changing where uploads are kept. An instance-wide decision, so it is an
 * administrator's to make.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setAvatarSettings } from "@/lib/avatar-service";
import { setUploadSettings } from "@/lib/tasks/attachment-service";

/** A storage connection id, `local`, or `auto`. */
const target = z.string().trim().min(1).max(128);

const settingsSchema = z.object({
    target,
    /** 1 MB to 10 GB. A limit outside that is a mistake rather than a policy. */
    maxBytes: z
        .number()
        .int()
        .min(1024 * 1024)
        .max(10 * 1024 * 1024 * 1024)
});

const avatarSchema = z.object({ target, gravatar: z.boolean() });

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

export async function setAvatarSettingsAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = avatarSchema.safeParse(input);
    if (!parsed.success) return { error: "Check the settings and try again" };
    try {
        await setAvatarSettings(parsed.data);
        await recordAudit({
            actorId: admin.id,
            action: "settings.avatars.update",
            targetType: "setting",
            targetId: "avatars",
            // Whether an instance talks to Gravatar is the part an operator may
            // later need to account for, so it is recorded alongside the target.
            metadata: { target: parsed.data.target, gravatar: parsed.data.gravatar }
        });
        return {};
    } catch (caught) {
        console.error(caught);
        return { error: "Could not save that" };
    }
}
