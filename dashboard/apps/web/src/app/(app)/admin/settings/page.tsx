import { SeenOnVisit } from "@/components/seen-on-visit";
import { PageHeader } from "@polaris/ui";
import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { TransferCard } from "./transfer-card";
import { getTranslations } from "@/lib/i18n/request";
import { SettingsCardsLoader, SettingsViewLoader } from "./loaders";
import { MAX_TERMINAL_SESSION_CAP } from "@/lib/terminal-session-cap";
import { AppUpdatesCard } from "@/components/app-bundles/app-updates-card";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const user = await requireAdmin();
    const t = await getTranslations("admin");
    const env = loadEnv();
    const revision = Date.now();

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title={t("settings.page.title")}
                description={t("settings.page.description")}
            />
            {/* The update this page shows is one the reader now knows about. */}
            <SeenOnVisit screen="/admin/settings" />
            <SettingsViewLoader
                revision={revision}
                deployment={{
                    hostname: env.POLARIS_LOCAL_HOSTNAME,
                    repo: env.POLARIS_REPO,
                    branch: env.POLARIS_UPDATE_BRANCH,
                    autoUpdate: env.POLARIS_AUTO_UPDATE
                }}
            />
            <AppUpdatesCard />
            <SettingsCardsLoader max={MAX_TERMINAL_SESSION_CAP} revision={revision} />
            <TransferCard identity={[user.email, user.name].filter(Boolean)} />
        </div>
    );
}
