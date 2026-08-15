/**
 * Where uploaded files are kept (/admin/uploads).
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { UploadsView } from "./uploads-view";
import { avatarSettings } from "@/lib/avatar-service";
import { chatStorageSettings } from "@/lib/chat/attachments";
import { uploadSettings } from "@/lib/tasks/attachment-service";

export const dynamic = "force-dynamic";

export default async function UploadsPage() {
    await requireAdmin();
    const [uploads, avatars, chat] = await Promise.all([
        uploadSettings(),
        avatarSettings(),
        chatStorageSettings()
    ]);

    return (
        <>
            <PageHeader
                title="Uploads"
                description="Where files, photos and things sent in chat are stored, and how big one may be."
            />
            <UploadsView uploads={uploads} avatars={avatars} chat={chat} />
        </>
    );
}
