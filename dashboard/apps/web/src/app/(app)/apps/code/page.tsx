/**
 * Code (/apps/code): the pull requests and issues waiting on somebody.
 *
 * Nothing is fetched on the server. The list is a live GitHub read scoped to
 * whoever is asking, and holding the navigation while a third party answers
 * would put a stranger's latency between somebody and their own dashboard - so
 * the page ships the frame and the filters at once and the rows arrive into it.
 */

import { CodeView } from "./code-view";
import { PageHeader } from "@polaris/ui";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";

export const dynamic = "force-dynamic";

export default async function CodePage() {
    await requirePermission("agents.read");
    const t = await getTranslations("code");

    return (
        <>
            <PageHeader
                title={t("page.title")}
                description={t("page.description")}
            />
            <CodeView />
        </>
    );
}
