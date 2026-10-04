/**
 * The front page of a place: how it is doing, at a glance.
 *
 * What is on, what needs somebody, each room with its controls, and the cameras
 * as one card among those - the live wall is a press away at /places/live. The
 * server hands over the frame and who may do what; everything inside it is read
 * by the client, so the page is on screen before any device account or camera
 * has been asked anything.
 */

import { placesT } from "../../lib/i18n";
import { PageHeader } from "@polaris/ui";
import { requireHomeReach } from "../../lib/access";
import { currentPlace } from "../../lib/current-place";
import { PlaceSwitcher } from "../../screens/place-switcher";
import { OverviewView } from "../../screens/overview/overview-view";

export const dynamic = "force-dynamic";

export default async function PlacePage() {
    const t = await placesT();
    // A visitor lent one door or one camera lands here too, and is shown that.
    const { install, reach, canManage, canControl } = await requireHomeReach();
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader title={place.current.name} description={t("pages.overview.description")} />
                <PlaceSwitcher places={place.places} current={place.current} canManage={canManage} />
            </div>
            <OverviewView
                placeId={place.current.id}
                places={place.places}
                resident={reach.everything}
                canControl={canControl}
                canManage={canManage}
            />
        </div>
    );
}
