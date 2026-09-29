import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { WatchContainersView } from "../watch-containers";

export const dynamic = "force-dynamic";

/** The page itself only checks who is asking; the containers are read from the
 *  daemons by the client, so the screen is never held behind them. */
export default async function WatchContainersPage() {
    await requirePermission("deploy.read");
    const t = await getTranslations("watch");

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title={t("containers.title")}
                description={t("containers.description")}
            />
            <WatchContainersView />
        </div>
    );
}
