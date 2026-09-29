/**
 * What the cameras noticed.
 *
 * The wall answers "what is happening"; this answers "what happened", which is
 * the question somebody actually opens Polaris for after the fact.
 */

import { PageHeader } from "@polaris/ui";
import { EventsView } from "../../../screens/events/events-view";
import { requireHomeUser } from "../../../lib/access";
import { placesT } from "../../../lib/i18n";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
    const t = await placesT();
    const { install, canControl, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.events.title")}
                    description={t("pages.events.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <EventsView canControl={canControl} />
        </div>
    );
}
