/**
 * The footage the house kept, and what to hold on to.
 */

import { PageHeader } from "@polaris/ui";
import { ClipsView } from "../../../screens/clips/clips-view";
import { requireHomeUser } from "../../../lib/access";
import { placesT } from "../../../lib/i18n";
import { currentPlace } from "../../../lib/current-place";
import { PlaceSwitcher } from "../../../screens/place-switcher";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
    const t = await placesT();
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title={t("pages.clips.title")}
                    description={t("pages.clips.description")}
                />
                <PlaceSwitcher
                    places={place.places}
                    current={place.current}
                    canManage={canManage}
                />
            </div>
            <ClipsView canManage={canManage} />
        </div>
    );
}
