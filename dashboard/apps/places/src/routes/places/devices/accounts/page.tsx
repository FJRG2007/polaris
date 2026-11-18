/**
 * The accounts the devices of a place come from: a maker's cloud, a bridge, a
 * hub on the network. Kept apart from the devices themselves, which are what
 * somebody opens to work a lock or a light; this is where a connection is
 * added, signed in again, adjusted or removed.
 */

import { PageHeader } from "@polaris/ui";
import { DevicesView } from "../../../../screens/devices/devices-view";
import { PlaceSwitcher } from "../../../../screens/place-switcher";
import { requireHomeUser } from "../../../../lib/access";
import { placesT } from "../../../../lib/i18n";
import { currentPlace } from "../../../../lib/current-place";
import { LentActionsProvider } from "../../../../screens/devices/lent-actions";

export const dynamic = "force-dynamic";

export default async function DeviceAccountsPage() {
    const t = await placesT();
    // A visitor lent one door has no business with the house's accounts.
    const { user, install, canControl, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.deviceAccounts.title")}
                    description={t("pages.deviceAccounts.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <LentActionsProvider lent={{}}>
                <DevicesView
                    section="accounts"
                    places={place.places}
                    placeId={place.current.id}
                    cacheKey={`${user.id}:${place.current.id}`}
                    canControl={canControl}
                    canManage={canManage}
                />
            </LentActionsProvider>
        </div>
    );
}
