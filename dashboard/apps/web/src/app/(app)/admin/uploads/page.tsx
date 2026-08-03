/**
 * Where uploaded files are kept (/admin/uploads).
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { UploadsView } from "./uploads-view";
import { avatarSettings } from "@/lib/avatar-service";
import { uploadSettings } from "@/lib/tasks/attachment-service";

export const dynamic = "force-dynamic";

export default async function UploadsPage() {
    await requireAdmin();
    const [uploads, avatars] = await Promise.all([uploadSettings(), avatarSettings()]);

    return (
        <>
            <PageHeader
                title="Uploads"
                description="Where files and profile photos are stored, and how big one may be."
            />
            <UploadsView uploads={uploads} avatars={avatars} />
        </>
    );
}
