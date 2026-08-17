/**
 * Who gets told, and about what.
 */

import { PageHeader } from "@polaris/ui";
import { AlertsView } from "./alerts-view";
import { requireHomeUser } from "@/lib/home/access";
import { currentPlace } from "@/lib/home/current-place";
import { PlaceSwitcher } from "../place-switcher";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
    const { install, canManage } = await requireHomeUser("home.read");
    const place = await currentPlace(install.id);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <div className="flex flex-wrap items-start justify-between gap-2">
                <PageHeader
                    title="Alerts"
                    description="What is worth interrupting somebody for. Each one arrives as a message in a conversation with the people it names."
                />
                <PlaceSwitcher places={place.places} current={place.current} canManage={canManage} />
            </div>
            <AlertsView canManage={canManage} />
        </div>
    );
}
