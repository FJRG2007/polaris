/**
 * The secrets on the open shelf (/automations/secrets): webhook URLs, tokens
 * and passwords steps send, stored encrypted and never shown again.
 */

import { PageHeader } from "@polaris/ui";
import { SecretsView } from "./secrets-view";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function AutomationSecretsPage() {
    const t = await getTranslations("automations");
    return (
        <div className="mx-auto w-full max-w-4xl">
            <PageHeader title={t("secrets.title")} description={t("secrets.description")} />
            <SecretsView />
        </div>
    );
}
