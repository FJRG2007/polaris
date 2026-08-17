/**
 * How the house is set up.
 *
 * Unlike the other Home screens this one is only for whoever runs it: what it
 * changes is where footage lands and what does the recognizing, which are
 * decisions about the deployment rather than about a camera.
 */

import { PageHeader } from "@polaris/ui";
import { footageTarget } from "@/lib/home/stills";
import { requireHomeUser } from "@/lib/home/access";
import { HomeSettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

export default async function HomeSettingsPage() {
    const { user } = await requireHomeUser("home.manage");
    const footage = await footageTarget(null);

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <PageHeader title="Settings" description="Where the house keeps what it records, and what recognizes faces." />
            <HomeSettingsView storage={footage.name} canAdmin={user.isAdmin} />
        </div>
    );
}
