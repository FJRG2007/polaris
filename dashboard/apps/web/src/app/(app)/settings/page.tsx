import { loadEnv } from "@polaris/config";
import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getUpdateStatus } from "@/lib/update-service";
import { listBackups } from "@/lib/backup-service";
import { SettingsView } from "./settings-view";

export const dynamic = "force-dynamic";

/**
 * General settings. Admin-only. Renders the initial update status server-side
 * (from the shared cache) and hands the deployment facts to the client view,
 * which owns the manual "Check for updates" action.
 */
export default async function SettingsPage() {
    await requireAdmin();
    const env = loadEnv();
    const [status, backups] = await Promise.all([getUpdateStatus(), listBackups()]);

    return (
        <>
            <PageHeader title="Settings" description="General configuration for this Polaris deployment." />
            <SettingsView
                initialStatus={status}
                initialBackups={backups}
                deployment={{
                    appUrl: env.POLARIS_APP_URL,
                    hostname: env.POLARIS_LOCAL_HOSTNAME,
                    repo: env.POLARIS_REPO,
                    branch: env.POLARIS_UPDATE_BRANCH,
                    autoUpdate: env.POLARIS_AUTO_UPDATE
                }}
            />
        </>
    );
}
