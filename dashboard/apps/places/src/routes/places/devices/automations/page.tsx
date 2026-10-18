/**
 * The automations of a place - what it does by itself: switch off what was left
 * on, lock what was left open, and tell somebody when either happened.
 *
 * They run on the central engine now, so this address is only the way in: it
 * opens the central list narrowed to Places' automations at the place being
 * looked at. Somebody the central list is not open to still gets this screen.
 * A visitor lent one door never sees either: it is the house's own standing
 * instructions.
 */

import { redirect } from "next/navigation";
import { host } from "@polaris/app-host";
import { placesAutomationsHref } from "../../../../lib/automation-kinds";

import { PageHeader } from "@polaris/ui";
import { placesT } from "../../../../lib/i18n";
import { requireHomeUser } from "../../../../lib/access";
import { currentPlace } from "../../../../lib/current-place";
import { PlaceSwitcher } from "../../../../screens/place-switcher";
import { AutomationsView } from "../../../../screens/automations/automations-view";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
    const t = await placesT();
    const { user, install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);
    if (await host.session.sessionCan(user, "automations.use"))
        redirect(placesAutomationsHref(place.current.id));

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.automations.title")}
                    description={t("pages.automations.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <AutomationsView placeId={place.current.id} canManage={canManage} />
        </div>
    );
}
