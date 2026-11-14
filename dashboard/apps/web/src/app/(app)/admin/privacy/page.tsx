/**
 * The instance-wide privacy settings (/admin/privacy): how far out an account's
 * page reaches, and what a stranger may type to find one. Each account still
 * narrows both for itself; these are the bounds and the defaults it starts on.
 */

import { PageHeader } from "@polaris/ui";
import { PrivacyLoader } from "./loader";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function PrivacyPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("privacy.page.title")} description={t("privacy.page.description")} />
            <PrivacyLoader revision={Date.now()} />
        </div>
    );
}
