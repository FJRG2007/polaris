import { PageHeader } from "@polaris/ui";
import { loadEnv } from "@polaris/config";
import { requireAdmin } from "@/lib/session";
import { UpdatesViewLoader } from "./loaders";
import { getTranslations } from "@/lib/i18n/request";
import { SeenOnVisit } from "@/components/seen-on-visit";
import { AppUpdatesCard } from "@/components/app-bundles/app-updates-card";

export const dynamic = "force-dynamic";

export default async function UpdatesPage() {
    await requireAdmin();
    const t = await getTranslations("admin");
    const env = loadEnv();

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("updates.page.title")} description={t("updates.page.description")} />
            {/* The update this page shows is one the reader now knows about. */}
            <SeenOnVisit screen="/admin/updates" />
            <UpdatesViewLoader
                revision={Date.now()}
                deployment={{
                    branch: env.POLARIS_UPDATE_BRANCH,
                    autoUpdate: env.POLARIS_AUTO_UPDATE
                }}
            />
            <AppUpdatesCard />
        </div>
    );
}
