/**
 * The people the house knows by sight.
 */

import { PageHeader } from "@polaris/ui";
import { PeopleView } from "../../../screens/people/people-view";
import { requireHomeUser } from "../../../lib/access";
import { placesT } from "../../../lib/i18n";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
    const t = await placesT();
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.people.title")}
                    description={t("pages.people.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <PeopleView canManage={canManage} />
        </div>
    );
}
