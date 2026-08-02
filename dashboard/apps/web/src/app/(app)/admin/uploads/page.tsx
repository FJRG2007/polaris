/**
 * Where uploaded files are kept (/admin/uploads).
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { UploadsView } from "./uploads-view";
import { uploadSettings } from "@/lib/tasks/attachment-service";

export const dynamic = "force-dynamic";

export default async function UploadsPage() {
    await requireAdmin();
    const settings = await uploadSettings();

    return (
        <>
            <PageHeader
                title="Uploads"
                description="Where files attached to work are stored, and how big one may be."
            />
            <UploadsView settings={settings} />
        </>
    );
}
