import { PageHeader } from "@polaris/ui";
import { listServerRows } from "../server-rows";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { INSIGHTS_MAX } from "@/lib/server-insights/request";
import { ServerInsightsPanel } from "./server-insights-panel";

export const dynamic = "force-dynamic";

/** Unusual activity and disk forecasts for every server the reader can see. The
 *  list of servers is a database read and paints with the page; the insights
 *  themselves arrive after it. */
export default async function ServerInsightsPage({
    searchParams
}: {
    searchParams: Promise<{ server?: string | string[] }>
}) {
    const user = await requirePermission("system.manage");
    const [rows, t, params] = await Promise.all([listServerRows(user.id), getTranslations("servers"), searchParams]);
    const servers = rows.slice(0, INSIGHTS_MAX).map((row) => ({ id: row.id, name: row.name }));
    const filter = typeof params.server === "string" ? params.server : null;
    return (
        <>
            <PageHeader title={t("insights.heading")} description={t("insights.description")} />
            <ServerInsightsPanel servers={servers} initialFilter={filter} />
        </>
    );
}
