/**
 * The people the house knows by sight.
 */

import { PageHeader } from "@polaris/ui";
import { PeopleView } from "./people-view";
import { requireHomeUser } from "@/lib/home/access";
import { currentPlace } from "@/lib/home/current-place";
import { PlaceSwitcher } from "../place-switcher";

export const dynamic = "force-dynamic";

export default async function PeoplePage() {
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title="People"
                    description="Teach the cameras who lives here, so everybody else is the one worth reporting. The photographs stay on the machine running the recognizer."
                />
                <PlaceSwitcher places={place.places} current={place.current} canManage={canManage} />
            </div>
            <PeopleView canManage={canManage} />
        </div>
    );
}
