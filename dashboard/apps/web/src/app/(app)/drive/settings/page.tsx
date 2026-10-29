/**
 * Drive settings (/drive/settings): how Drive behaves for the account signed in.
 *
 * For now the one question Drive can be told to stop asking - whether moving
 * something to the bin asks first - and the place to start asking again.
 */

import { PageHeader } from "@polaris/ui";
import { DriveSettings } from "./drive-settings";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { loadDrivePreferences } from "@/lib/drive-preferences";

export const dynamic = "force-dynamic";

export default async function DriveSettingsPage() {
    const t = await getTranslations("drive");
    const user = await requirePermission("drive.read");
    const preferences = await loadDrivePreferences(user.id);

    return (
        <div className="flex flex-col gap-4">
            <PageHeader title={t("pages.settings.title")} description={t("pages.settings.description")} />
            <DriveSettings initial={preferences} />
        </div>
    );
}
