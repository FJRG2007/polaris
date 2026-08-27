"use server";

/**
 * Changing where uploads are kept. An instance-wide decision, so it is an
 * administrator's to make.
 */

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { chatTarget } from "@/lib/chat/attachments";
import { avatarSettings } from "@/lib/avatar-service";
import { setAvatarSettings } from "@/lib/avatar-service";
import { checkStorageTarget } from "@/lib/storage-target";
import { personalDriveSettings, setPersonalDriveTarget } from "@/lib/personal-drive";
import { uploadSettings } from "@/lib/tasks/attachment-service";
import { setUploadSettings } from "@/lib/tasks/attachment-service";
import { footageSettings, setFootageTarget } from "@/lib/home/stills";
import { setChatStorageTarget, tidyChatStorage } from "@/lib/chat/attachments";

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

/** Where chat attachments go. Its own answer, like every other kind of upload:
 *  "same as profile photos" made this screen describe itself by pointing at
 *  another one, and moved every file in every conversation whenever the photos
 *  moved. */
/**
 * Where camera footage is kept by default.
 *
 * Here rather than inside Home, so an operator sets every kind of upload in one
 * place - and so there is exactly one instance-wide answer. A camera may still
 * name its own disk; that is a decision about one camera, and it lives on the
 * camera.
 */
export async function setFootageTargetAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target }).safeParse(input);
    if (!parsed.success) return { error: "Check the settings and try again" };
    try {
        await setFootageTarget(parsed.data.target);
        await recordAudit({
            actorId: admin.id,
            action: "settings.home.footage.update",
            targetType: "setting",
            targetId: "home.footage",
            metadata: { target: parsed.data.target }
        });
        return {};
    } catch {
        return { error: "That could not be saved" };
    }
}

export async function setChatStorageTargetAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target }).safeParse(input);
    if (!parsed.success) return { error: "Check the settings and try again" };
    try {
        await setChatStorageTarget(parsed.data.target);
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

/**
 * Take out what no conversation answers for.
 *
 * A conversation deleted by an older build left its whole folder on the storage,
 * and a message deleted one at a time left an empty one. Nothing in Polaris can
 * reach either, so nothing but this will ever remove them.
 */
export async function tidyChatStorageAction(): Promise<{
    removed?: number;
    failed?: number;
    error?: string;
}> {
    const admin = await requireAdmin();
    try {
        const result = await tidyChatStorage();
        await recordAudit({
            actorId: admin.id,
            action: "settings.chat.uploads.tidy",
            targetType: "setting",
            targetId: "chat.attachments",
            metadata: { removed: result.removed, failed: result.failed }
        });
        return result;
    } catch (caught) {
        console.error(caught);
        return { error: "That storage could not be tidied" };
    }
}

export async function setPersonalDriveTargetAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target }).safeParse(input);
    if (!parsed.success) return { error: "Check the settings and try again" };
    try {
        await setPersonalDriveTarget(parsed.data.target);
        await recordAudit({
            actorId: admin.id,
            action: "settings.drive.personal.update",
            targetType: "setting",
            targetId: "drive.personal",
            metadata: { target: parsed.data.target }
        });
        return {};
    } catch (caught) {
        console.error(caught);
        return { error: "Could not save that" };
    }
}

/** The questions this screen answers, and the folder each writes under. */
const CHECKS = {
    tasks: "uploads",
    avatars: "avatars",
    chat: "chat",
    footage: "home",
    drive: "drive"
} as const;

export type StorageCheck = keyof typeof CHECKS;

/**
 * Prove that a target actually works, rather than that it was accepted.
 *
 * Every one of these settings is a promise about where bytes will be next week,
 * and the only way to test a promise like that is to make it and then ask for
 * the bytes back. What this catches is the failure nothing else does: storage
 * that takes a file and will not return it, which reaches somebody as an
 * attachment that 404s long after whoever sent it has gone.
 */
export async function checkStorageAction(
    which: StorageCheck
): Promise<{ ok: boolean; detail: string; where: string }> {
    await requireAdmin();
    const folder = CHECKS[which] ?? CHECKS.tasks;

    const target =
        which === "chat"
            ? await chatTarget()
            : which === "drive"
              ? (await personalDriveSettings()).resolved
              : which === "avatars"
                ? (await avatarSettings()).resolved
                : which === "footage"
                  ? (await footageSettings()).resolved
                  : (await uploadSettings()).resolved;

    const result = await checkStorageTarget(target.id, folder);
    return {
        ...result,
        where: target.name
    };
}
