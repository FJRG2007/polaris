import { PageHeader } from "@polaris/ui";
import { WatchCardList } from "../watch-cards";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { getWatchServices } from "@/lib/watch-overview-service";

export const dynamic = "force-dynamic";

export default async function WatchServicesPage() {
    const user = await requirePermission("deploy.read");
    const t = await getTranslations("watch");
    const services = await getWatchServices(user.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <PageHeader
                title={t("overview.services")}
                description={t("services.description")}
            />
            <WatchCardList cards={services} label={t("services.listLabel")} empty={t("overview.noServices")} />
        </div>
    );
}
