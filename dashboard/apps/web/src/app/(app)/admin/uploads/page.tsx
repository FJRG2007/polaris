/**
 * Where uploaded files are kept (/admin/uploads).
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { UploadsView } from "./uploads-view";
import { homeInstall } from "@/lib/home/access";
import { avatarSettings } from "@/lib/avatar-service";
import { footageSettings } from "@/lib/home/stills";
import { chatStorageSettings } from "@/lib/chat/attachments";
import { personalDriveSettings } from "@/lib/personal-drive";
import { organizationDriveSettings } from "@/lib/organization-drive";
import { uploadSettings } from "@/lib/tasks/attachment-service";

export const dynamic = "force-dynamic";

export default async function UploadsPage() {
    await requireAdmin();
    const [uploads, avatars, chat, drives, orgDrives, house] = await Promise.all([
        uploadSettings(),
        avatarSettings(),
        chatStorageSettings(),
        personalDriveSettings(),
        organizationDriveSettings(),
        homeInstall()
    ]);
    // Only asked for when there is a house: on an instance with no cameras it is
    // a setting for something that does not exist.
    const footage = house ? await footageSettings() : null;

    return (
        // Narrow page: three settings cards and nothing wide, so the column is
        // centred in the content area, header included, rather than left against
        // the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Uploads"
                description="Where people’s own drives, organizations’ shelves, files, photos, things sent in chat and camera footage are stored, and how big one may be."
            />
            <UploadsView
                uploads={uploads}
                avatars={avatars}
                chat={chat}
                drives={drives}
                orgDrives={orgDrives}
                footage={footage}
            />
        </div>
    );
}
