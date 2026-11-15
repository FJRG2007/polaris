/**
 * A place's wall panels as a table. Each row opens the panel's own page
 * (`/places/panels/<id>`), where it is arranged and previewed.
 */

import { PageHeader } from "@polaris/ui";
import { placesT } from "../../../lib/i18n";
import { listPanels } from "../../../lib/panels";
import { requireHomeUser } from "../../../lib/access";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";
import { PanelsTable } from "../../../screens/panels/panels-table";

export const dynamic = "force-dynamic";

export default async function PanelsPage() {
    const t = await placesT();
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);
    const placeId = place.current.id;
    const panels = await listPanels(install.id, placeId);
    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title={t("panels.title")} description={t("panels.description")} />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <PanelsTable
                key={placeId}
                panels={panels}
                placeName={place.current.name}
                canManage={canManage}
            />
        </div>
    );
}
