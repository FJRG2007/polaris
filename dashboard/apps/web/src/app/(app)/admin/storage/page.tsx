/**
 * Storage locations (/admin/storage).
 *
 * A disk filled and took a server down with it, and the NAS beside it had room
 * nobody could use from here. This is where Polaris is told about that NAS, says
 * how full every place is, and moves a service's data from one to the other -
 * stopping the service, copying and checking its files, starting it again on the
 * copy, and leaving the original until somebody says it can go.
 *
 * The page awaits nothing but the session: every region loads on its own.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { StorageView } from "./storage-view";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function StoragePage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    return (
        <div className="mx-auto flex w-full max-w-4xl flex-col">
            <PageHeader title={t("storage.title")} description={t("storage.description")} />
            <StorageView />
        </div>
    );
}
