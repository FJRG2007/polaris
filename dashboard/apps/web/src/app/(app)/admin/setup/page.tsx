/**
 * Get started (/admin/setup): the first-run setup, opened again on purpose.
 *
 * The page is drawn at once; only the app list waits for the server to say what
 * this Polaris already has (see `SetupWizardPanel`).
 */

import { Card, CardBody, PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { SetupWizardPanel } from "@/components/setup/setup-wizard-entry";

export const dynamic = "force-dynamic";

export default async function SetupPage() {
    await requireAdmin();
    const t = await getTranslations("setup");

    return (
        <div className="mx-auto flex w-full max-w-2xl flex-col">
            <PageHeader title={t("page.title")} description={t("page.intro")} />
            <Messages namespaces={["setup", "catalog"]}>
                <Card>
                    <CardBody>
                        <SetupWizardPanel />
                    </CardBody>
                </Card>
            </Messages>
        </div>
    );
}
