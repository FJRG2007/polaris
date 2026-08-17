/**
 * The footage the house kept, and what to hold on to.
 */

import { PageHeader } from "@polaris/ui";
import { ClipsView } from "./clips-view";
import { requireHomeUser } from "@/lib/home/access";
import { currentPlace } from "@/lib/home/current-place";
import { PlaceSwitcher } from "../place-switcher";

export const dynamic = "force-dynamic";

export default async function ClipsPage() {
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title="Clips"
                    description="Recordings, newest first. Anything you keep survives the retention window."
                />
                <PlaceSwitcher places={place.places} current={place.current} canManage={canManage} />
            </div>
            <ClipsView canManage={canManage} />
        </div>
    );
}
