/** Places: one place at a glance - its cameras beside each room's own controls. */

import { PageHeader } from "@polaris/ui";
import { Chrome } from "../runtime/chrome";
import { defineScene } from "../runtime/scene";
import { placesCatalogs } from "../../../apps/places/messages";
import { CABIN_ID, placeOverview, places } from "../fixtures/places";
import { PlaceSwitcher } from "../../../apps/places/src/screens/place-switcher";
import { OverviewView } from "../../../apps/places/src/screens/overview/overview-view";

export const placesOverview = defineScene({
    id: "places",
    path: "/places",
    actions: (ctx) => ({ placeOverviewAction: () => ({ overview: placeOverview(ctx) }) }),
    // The page `/places` draws, with what it would have read.
    render: (ctx) => {
        const t = placesCatalogs.translator(ctx.locale, "places");
        const all = places(ctx);
        const current = all.find((place) => place.id === CABIN_ID)!;
        return (
            <Chrome>
                <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                        <PageHeader
                            title={current.name}
                            description={t("pages.overview.description")}
                        />
                        <PlaceSwitcher places={all} current={current} canManage />
                    </div>
                    <OverviewView placeId={CABIN_ID} places={all} resident canControl canManage />
                </div>
            </Chrome>
        );
    }
});
