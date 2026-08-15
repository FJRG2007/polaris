"use server";

/**
 * Changing where uploads are kept. An instance-wide decision, so it is an
 * administrator's to make.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { setAvatarSettings } from "@/lib/avatar-service";
import { setChatStorageTarget } from "@/lib/chat/attachments";
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

/**
 * Where chat attachments go.
 *
 * `follow-avatars` is stored as no choice at all, which is what makes it a
 * living default rather than a copy: pointing profile photos at a NAS moves chat
 * with them, until somebody answers this question separately.
 */
export async function setChatStorageTargetAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target: z.union([target, z.literal("follow-avatars")]) }).safeParse(input);
    if (!parsed.success) return { error: "Check the settings and try again" };
    try {
        await setChatStorageTarget(
            parsed.data.target === "follow-avatars" ? null : parsed.data.target
        );
        await recordAudit({
            actorId: admin.id,
            action: "settings.chat.uploads.update",
            targetType: "setting",
            targetId: "chat.attachments",
            metadata: { target: parsed.data.target }
        });
        return {};
    } catch (caught) {
        console.error(caught);
        return { error: "Could not save that" };
    }
}
