import { PageHeader } from "@polaris/ui";
import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { SettingsView } from "./settings-view";
import { getUpdateSource } from "@/lib/update-source";
import { getUpdateStatus } from "@/lib/update-service";
import { checkedAddresses } from "@/lib/address-health";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";

export const dynamic = "force-dynamic";

/**
 * General settings. Admin-only. Renders the initial update status server-side
 * (from the shared cache) and hands the deployment facts to the client view,
 * which owns the manual "Check for updates" action.
 */
export default async function SettingsPage() {
    await requireAdmin();
    const env = loadEnv();
    const [status, policy, source, addresses] = await Promise.all([
        getUpdateStatus(),
        getAutoUpdatePolicy(),
        getUpdateSource(),
        checkedAddresses()
    ]);

    return (
        // Narrow page: centre the column in the content area, header included, and
        // keep it at the top so it does not shift as the update card grows.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title="Settings" description="General configuration for this Polaris deployment." />
            <SettingsView
                initialStatus={status}
                initialPolicy={policy}
                initialSource={source}
                deployment={{
                    addresses,
                    hostname: env.POLARIS_LOCAL_HOSTNAME,
                    repo: env.POLARIS_REPO,
                    branch: env.POLARIS_UPDATE_BRANCH,
                    autoUpdate: env.POLARIS_AUTO_UPDATE
                }}
            />
        </div>
    );
}
