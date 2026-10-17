/**
 * The automations on the open shelf (/automations). The shell paints at once;
 * the list is fetched by the client and only its own region waits.
 */

import { PageHeader } from "@polaris/ui";
import { getTranslations } from "@/lib/i18n/request";
import { AutomationsList } from "./automations-list";

export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
    const t = await getTranslations("automations");
    return (
        <div className="mx-auto w-full max-w-4xl">
            <PageHeader title={t("title")} description={t("description")} />
            <AutomationsList />
        </div>
    );
}
