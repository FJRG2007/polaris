/**
 * How the house is set up.
 *
 * Unlike the other Home screens this one is only for whoever runs it: what it
 * changes is where footage lands and what does the recognizing, which are
 * decisions about the deployment rather than about a camera.
 */

import { PageHeader } from "@polaris/ui";
import { getSetting } from "@/lib/setting-store";
import { HOME_TARGET_KEY } from "@/lib/home/stills";
import { requireHomeUser } from "@/lib/home/access";
import { HomeSettingsView } from "./settings-view";
import { AUTOMATIC_TARGET, LOCAL_TARGET, storageTargetOptions } from "@/lib/storage-target";

export const dynamic = "force-dynamic";

export default async function HomeSettingsPage() {
    await requireHomeUser("home.manage");
    const [chosen, connections] = await Promise.all([getSetting(HOME_TARGET_KEY), storageTargetOptions()]);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <PageHeader title="Settings" description="Where the house keeps what it records, and what recognizes faces." />
            <HomeSettingsView
                storage={chosen ?? AUTOMATIC_TARGET}
                targets={[
                    { id: AUTOMATIC_TARGET, label: "Wherever Polaris keeps uploads" },
                    { id: LOCAL_TARGET, label: "This server" },
                    ...connections.map((connection) => ({ id: connection.id, label: connection.name }))
                ]}
            />
        </div>
    );
}
