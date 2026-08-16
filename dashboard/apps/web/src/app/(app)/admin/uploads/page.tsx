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
        // Narrow page: three settings cards and nothing wide, so the column is
        // centred in the content area, header included, rather than left against
        // the rail with the width beside it empty.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title="Uploads"
                description="Where files, photos and things sent in chat are stored, and how big one may be."
            />
            <UploadsView uploads={uploads} avatars={avatars} chat={chat} />
        </div>
    );
}
