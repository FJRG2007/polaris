/**
 * "Recent" page (/drive/recent): recently modified, created, or opened files for
 * a connection, like a file manager's recent list. Server component that resolves
 * the connections the user can read and hands them to the client view, which does
 * the (network-bound) recent lookup itself so the page paints instantly.
 */

import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { listAccessibleConnections } from "@/lib/storage-service";
import { RecentView } from "./recent-view";

export const dynamic = "force-dynamic";

export default async function RecentPage() {
    const t = await getTranslations("drive");
    const user = await requirePermission("drive.read");
    const connections = (await listAccessibleConnections(user.id, await scopeOrgIdFor(user.id))).map((row) => ({ id: row.id, name: row.name }));

    return (
        <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <div>
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">{t("pages.recent.title")}</h1>
                <p className="text-sm text-muted-foreground">
                    {t("pages.recent.description")}
                </p>
            </div>
            <RecentView connections={connections} />
        </div>
    );
}
