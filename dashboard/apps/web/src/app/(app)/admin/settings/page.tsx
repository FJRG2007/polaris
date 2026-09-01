import { PageHeader } from "@polaris/ui";
import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { SettingsView } from "./settings-view";
import { getUpdateSource } from "@/lib/update-source";
import { getAutoUpdatePolicy } from "@/lib/update-watcher";
import { getLegalContact, publicUrls } from "@/lib/legal/service";

export const dynamic = "force-dynamic";

/**
 * General settings. Admin-only.
 *
 * Only what is already known is awaited here: the environment, the update
 * schedule, the source and the public-page contact are all settings reads. The
 * three answers that go out to the network - what GitHub has, whether each
 * configured address answers, and what this box's public address is - are
 * fetched by the view once it has painted, because between them they used to
 * hold the navigation itself open with nothing on screen to say why. See
 * `/api/admin/settings/overview`.
 */
export default async function SettingsPage() {
    await requireAdmin();
    const env = loadEnv();
    const [policy, source, contact, publicPages] = await Promise.all([
        getAutoUpdatePolicy(),
        getUpdateSource(),
        // The public pages, which are the only part of this deployment an outside
        // review desk can read - and the one line on them an operator writes.
        getLegalContact(),
        publicUrls()
    ]);

    return (
        // Narrow page: centre the column in the content area, header included, and
        // keep it at the top so it does not shift as the update card grows.
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title="Settings" description="General configuration for this Polaris deployment." />
            <SettingsView
                initialPolicy={policy}
                initialSource={source}
                initialContact={contact ?? ""}
                publicPages={publicPages}
                deployment={{
                    hostname: env.POLARIS_LOCAL_HOSTNAME,
                    repo: env.POLARIS_REPO,
                    branch: env.POLARIS_UPDATE_BRANCH,
                    autoUpdate: env.POLARIS_AUTO_UPDATE
                }}
            />
        </div>
    );
}
