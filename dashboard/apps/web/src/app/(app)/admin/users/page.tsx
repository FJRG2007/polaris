import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { UsersAdminLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

/** The heading paints at once; the directory is asked for after (`UsersAdminLoader`). */
export default async function UsersAdminPage({
    searchParams
}: {
    searchParams: Promise<{ user?: string }>;
}) {
    const { user } = await searchParams;
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <>
            <PageHeader title={t("users.page.title")} description={t("users.page.description")} />
            <div className="flex flex-col gap-4">
                <UsersAdminLoader openUserId={user ?? null} revision={Date.now()} />
            </div>
        </>
    );
}
