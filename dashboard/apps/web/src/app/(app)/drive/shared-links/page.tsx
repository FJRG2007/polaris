/**
 * "Shared links" page (/drive/shared-links): the current user's outgoing share
 * links. Server component that loads the owner's shares and hands them to the
 * client view for revealing the link, editing limits, inspecting access logs,
 * opening the shared file in Drive, and revoking.
 */

import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { listSharesForOwner } from "@/lib/share-service";
import { toShareRow } from "./share-row";
import { SharedView } from "./shared-links-view";

export const dynamic = "force-dynamic";

export default async function SharedPage() {
    const t = await getTranslations("drive");
    const user = await requirePermission("drive.read");
    const shares = await listSharesForOwner(user.id);
    const rows = shares.map(toShareRow);

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                    {t("pages.sharedLinks.title")}
                </h1>
                <p className="text-sm text-muted-foreground">
                    {t("pages.sharedLinks.description")}
                </p>
            </div>
            <SharedView shares={rows} />
        </div>
    );
}
