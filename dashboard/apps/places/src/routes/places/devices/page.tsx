/**
 * The devices of a place - everything in it that is done rather than watched.
 *
 * Its own screen rather than a strip on the wall, for the reason the cameras have
 * their own: the wall is what somebody opens twenty times a day and should be
 * nothing but pictures. This is what they open to lock up, to let somebody in, to
 * switch something off from the car, or to find out who did.
 */

import { PageHeader } from "@polaris/ui";
import { DevicesView } from "../../../screens/devices/devices-view";
import { PlaceSwitcher } from "../../../screens/place-switcher";
import { requireHomeReach } from "../../../lib/access";
import { placesT } from "../../../lib/i18n";
import { currentPlace } from "../../../lib/current-place";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
    const t = await placesT();
    // Somebody lent one door reaches this screen, and sees that door.
    const { user, install, canControl, canManage } = await requireHomeReach();
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.devices.title")}
                    description={t("pages.devices.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <DevicesView
                places={place.places}
                placeId={place.current.id}
                cacheKey={`${user.id}:${place.current.id}`}
                canControl={canControl}
                canManage={canManage}
            />
        </div>
    );
}
