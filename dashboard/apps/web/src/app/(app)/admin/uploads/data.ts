"use server";

import { requireAdmin } from "@/lib/session";
import { avatarSettings } from "@/lib/avatar-service";
import { footageSettings } from "@/lib/footage-storage";
import { chatStorageSettings } from "@/lib/chat/attachments";
import { isAppInstalled } from "@/lib/apps/install-presence";
import { personalDriveSettings } from "@/lib/personal-drive";
import { uploadSettings } from "@/lib/tasks/attachment-service";
import { listWhereabouts } from "@/lib/storage-whereabouts/follow";
import { organizationDriveSettings } from "@/lib/organization-drive";

/** Where each kind of upload is stored. */
export async function loadUploadsAction() {
    await requireAdmin();
    const [uploads, avatars, chat, drives, orgDrives, house, network] = await Promise.all([
        uploadSettings(),
        avatarSettings(),
        chatStorageSettings(),
        personalDriveSettings(),
        organizationDriveSettings(),
        isAppInstalled("home"),
        listWhereabouts()
    ]);
    // Only asked for when there is a house: on an instance with no cameras it is
    // a setting for something that does not exist.
    const footage = house ? await footageSettings() : null;
    return { uploads, avatars, chat, drives, orgDrives, footage, network };
}
