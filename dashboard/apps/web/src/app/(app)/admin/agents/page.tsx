/**
 * Agent defaults admin (/admin/agents): what every account's own Agents settings
 * fall through to, and what a repository nobody has configured starts from.
 * Polar's own settings are under Polaris apps > Polar > Settings; the keys,
 * limits and catalogue here are read by both.
 */

import Link from "next/link";
import { PageHeader } from "@polaris/ui";
import { appSettingsPath } from "@/lib/apps/app-settings";
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
            <p className="text-muted-foreground mb-4 text-xs">
                {t.rich("agents.page.polar", {
                    link: (chunks) => (
                        <Link key="polar" href={appSettingsPath("polar")} className="text-primary hover:underline">
                            {chunks}
                        </Link>
                    )
                })}
            </p>
            <AgentsAdminLoader revision={Date.now()} />
        </div>
    );
}
