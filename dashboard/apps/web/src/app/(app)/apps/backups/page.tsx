/**
 * Backups (/apps/backups). What is protected, under which policy, where the
 * copies went, and what has run.
 *
 * The page awaits nothing. It renders the header and hands over to the console,
 * which fetches its own data after the first paint - the version this replaced
 * awaited a filesystem listing and a round trip into every game server before it
 * rendered a single pixel, so opening it showed an empty screen for as long as
 * the slowest server took to answer.
 *
 * Admin-only: a backup reaches every app's data.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { BackupsView } from "./backups-view";

export default async function BackupsPage() {
    await requireAdmin();

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col">
            <PageHeader
                title="Backups"
                description="What is protected, how often it is copied, and where those copies live."
            />
            <BackupsView />
        </div>
    );
}
