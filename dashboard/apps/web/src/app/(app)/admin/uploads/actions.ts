"use server";

/**
 * Changing where uploads are kept. An instance-wide decision, so it is an
 * administrator's to make.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { isLocalAddress } from "@polaris/core";
import * as whereabouts from "@/lib/storage-whereabouts/follow";
import type { WhereaboutsView } from "@/lib/storage-whereabouts/follow";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { recordAudit } from "@/lib/audit-service";
import { chatTarget } from "@/lib/chat/attachments";
import { avatarSettings } from "@/lib/avatar-service";
import { setAvatarSettings } from "@/lib/avatar-service";
import { checkStorageTarget } from "@/lib/storage-target";
import { personalDriveSettings, setPersonalDriveTarget } from "@/lib/personal-drive";
import { organizationDriveSettings, setOrganizationDriveTarget } from "@/lib/organization-drive";
import { uploadSettings } from "@/lib/tasks/attachment-service";
import { setUploadSettings } from "@/lib/tasks/attachment-service";
import { footageSettings, setFootageTarget } from "@/lib/footage-storage";
import { setChatStorageTarget, tidyChatStorage } from "@/lib/chat/attachments";
import { tidyEmojiStorage } from "@/lib/chat/custom-emoji";

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
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("uploads.errors.checkSettings") };
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
        return { error: (await getTranslations("admin"))("uploads.errors.saveFailed") };
    }
}

export async function setAvatarSettingsAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = avatarSchema.safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("uploads.errors.checkSettings") };
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
        return { error: (await getTranslations("admin"))("uploads.errors.saveFailed") };
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
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("uploads.errors.checkSettings") };
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
        return { error: (await getTranslations("admin"))("uploads.errors.notSaved") };
    }
}

export async function setChatStorageTargetAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target }).safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("uploads.errors.checkSettings") };
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
        return { error: (await getTranslations("admin"))("uploads.errors.saveFailed") };
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
        // The space emoji's root as well: a space removed with its owner's
        // account leaves that folder behind the same way.
        const [files, emoji] = await Promise.all([tidyChatStorage(), tidyEmojiStorage()]);
        const result = {
            removed: files.removed + emoji.removed,
            failed: files.failed + emoji.failed
        };
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
        return { error: (await getTranslations("admin"))("uploads.errors.tidyFailed") };
    }
}

export async function setPersonalDriveTargetAction(input: unknown): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target }).safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("uploads.errors.checkSettings") };
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
        return { error: (await getTranslations("admin"))("uploads.errors.saveFailed") };
    }
}

export async function setOrganizationDriveTargetAction(
    input: unknown
): Promise<{ error?: string }> {
    const admin = await requireAdmin();
    const parsed = z.object({ target }).safeParse(input);
    if (!parsed.success)
        return { error: (await getTranslations("admin"))("uploads.errors.checkSettings") };
    try {
        await setOrganizationDriveTarget(parsed.data.target);
        await recordAudit({
            actorId: admin.id,
            action: "settings.drive.organization.update",
            targetType: "setting",
            targetId: "drive.organization",
            metadata: { target: parsed.data.target }
        });
        return {};
    } catch (caught) {
        console.error(caught);
        return { error: (await getTranslations("admin"))("uploads.errors.saveFailed") };
    }
}

/** The questions this screen answers, and the folder each writes under. */
const CHECKS = {
    tasks: "uploads",
    avatars: "avatars",
    chat: "chat",
    footage: "home",
    drive: "drive",
    orgDrive: "drive"
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
              : which === "orgDrive"
                ? (await organizationDriveSettings()).resolved
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

const storageIdSchema = z.string().uuid();

/**
 * Look for a storage's device on the network now, rather than waiting for the
 * next upload that fails or the next scheduled look. Follows it when it proves
 * to be the same device somewhere else.
 */
export async function findStorageAgainAction(id: unknown): Promise<{
    view?: WhereaboutsView;
    error?: string;
}> {
    await requireAdmin();
    const parsed = storageIdSchema.safeParse(id);
    const t = await getTranslations("admin");
    if (!parsed.success) return { error: t("uploads.network.notFound") };
    try {
        await whereabouts.searchFor(parsed.data, { force: true });
        const view = (await whereabouts.listWhereabouts()).find((one) => one.id === parsed.data);
        return view ? { view } : { error: t("uploads.network.notFound") };
    } catch (caught) {
        console.error(caught);
        return { error: t("uploads.network.searchFailed") };
    }
}

const addressSchema = z.object({
    id: z.string().uuid(),
    address: z
        .string()
        .trim()
        .min(1)
        .max(15)
        .refine((value) => isLocalAddress(value)),
    /** The person saw who answers there and chose it anyway - only asked when the
     *  storage has never said who it is, so there is nothing to prove it by. */
    accept: z.boolean().default(false)
});

/**
 * Give a storage on the network a new address, checked by who answers there.
 *
 * The stored password goes wherever this points, so the device at the new
 * address has to be the one the storage remembers. One that never said who it
 * was is shown to the person first, and used only once they say so.
 */
export async function setStorageAddressAction(input: unknown): Promise<{
    view?: WhereaboutsView;
    confirm?: { device: string };
    error?: string;
}> {
    const admin = await requireAdmin();
    const t = await getTranslations("admin");
    const parsed = addressSchema.safeParse(input);
    if (!parsed.success) return { error: t("uploads.network.addressFormat") };
    const { id, address, accept } = parsed.data;

    const row = await prisma.storageConnection.findUnique({
        where: { id },
        select: { id: true, name: true, kind: true, config: true, deviceIdentity: true }
    });
    if (!row || !whereabouts.isFollowable(row)) return { error: t("uploads.network.notFound") };
    const before = whereabouts.addressOf(row);

    try {
        if (before !== address) {
            const check = await whereabouts.checkAddress(row, address);
            if (check.kind === "different") {
                return {
                    error: t("uploads.network.different", {
                        address,
                        device: check.label ?? address,
                        name: row.name
                    })
                };
            }
            if (check.kind === "silent") return { error: t("uploads.network.silent", { address }) };
            if (check.kind === "unproven" && !accept)
                return { confirm: { device: check.label ?? address } };
            if (!(await whereabouts.moveToAddress(row, address, check.identity))) {
                return { error: t("uploads.network.changed") };
            }
            await recordAudit({
                actorId: admin.id,
                action: "storage.address.update",
                targetType: "connection",
                targetId: id,
                metadata: { from: before, to: address, confirmed: check.kind === "same" }
            });
        }
        const view = (await whereabouts.listWhereabouts()).find((one) => one.id === id);
        return view ? { view } : { error: t("uploads.network.notFound") };
    } catch (caught) {
        console.error(caught);
        return { error: t("uploads.errors.saveFailed") };
    }
}
