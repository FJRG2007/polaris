/**
 * Who gets told, and about what.
 */

import { PageHeader } from "@polaris/ui";
import { AlertsView } from "../../../screens/alerts/alerts-view";
import { requireHomeUser } from "../../../lib/access";
import { placesT } from "../../../lib/i18n";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
    const t = await placesT();
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.alerts.title")}
                    description={t("pages.alerts.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <AlertsView canManage={canManage} />
        </div>
    );
}
