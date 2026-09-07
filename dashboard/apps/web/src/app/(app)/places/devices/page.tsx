/**
 * The doors of a place.
 *
 * Its own screen rather than a strip on the wall, for the reason the cameras have
 * their own: the wall is what somebody opens twenty times a day and should be
 * nothing but pictures. This is what they open to lock up, to let somebody in, or
 * to find out who did.
 */

import { PageHeader } from "@polaris/ui";
import { DevicesView } from "./devices-view";
import { PlaceSwitcher } from "../place-switcher";
import { requireHomeUser } from "@/lib/home/access";
import { currentPlace } from "@/lib/home/current-place";

export const dynamic = "force-dynamic";

export default async function DevicesPage() {
    const { install, canControl, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title="Doors"
                    description="The locks at this place: what they are doing, who has used them, and the buttons to lock or open one."
                />
                <PlaceSwitcher places={place.places} current={place.current} canManage={canManage} />
            </div>
            <DevicesView places={place.places} canControl={canControl} canManage={canManage} />
        </div>
    );
}
