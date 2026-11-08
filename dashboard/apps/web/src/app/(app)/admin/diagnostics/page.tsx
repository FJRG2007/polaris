/**
 * Management > Diagnostics: what is wrong with this deployment, how fast it
 * reaches the internet, and a bundle to hand to whoever is helping.
 *
 * Nothing slow is awaited here. The checks go out to the network, so the page
 * paints every row with its name and a placeholder, and the view asks for each
 * check on its own. Only the last speed result - one settings read - is passed
 * down, so a revisit shows it at once.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { DiagnosticsLoader } from "./loader";
import { Messages } from "@/components/i18n/messages";
import { getTranslations } from "@/lib/i18n/request";
import { CHECK_IDS } from "@/lib/diagnostics/checks";

export const dynamic = "force-dynamic";

export default async function DiagnosticsPage() {
    await requireAdmin();
    const t = await getTranslations("diagnostics");

    return (
        <div className="mx-auto flex w-full max-w-3xl flex-col">
            <PageHeader title={t("page.title")} description={t("page.description")} />
            <Messages namespaces={["diagnostics"]}>
                <DiagnosticsLoader checks={[...CHECK_IDS]} />
            </Messages>
        </div>
    );
}
