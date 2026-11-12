import { PageHeader } from "@polaris/ui";
import { SeasonalLoader } from "./loader";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function SeasonalThemesPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader
                title={t("seasonalThemes.page.title")}
                description={t("seasonalThemes.page.description")}
            />
            <SeasonalLoader revision={Date.now()} />
        </div>
    );
}
