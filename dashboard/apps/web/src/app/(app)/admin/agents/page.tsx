/**
 * Agent defaults admin (/admin/agents): what every account's own Agents settings
 * fall through to, and what a repository nobody has configured starts from.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { AgentsAdminLoader } from "./loader";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AgentDefaultsAdminPage() {
    await requireAdmin();
    const t = await getTranslations("admin");

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("agents.page.title")} description={t("agents.page.description")} />
            <AgentsAdminLoader revision={Date.now()} />
        </div>
    );
}
