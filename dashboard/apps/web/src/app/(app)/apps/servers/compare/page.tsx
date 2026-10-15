import { PageHeader } from "@polaris/ui";
import { listServerRows } from "../server-rows";
import { CompareView } from "./compare-view";
import { requirePermission } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { RANGE_ORDER, type RangePreset } from "@/lib/metrics-shared";
import { COMPARE_MAX } from "@/lib/server-insights/request";

export const dynamic = "force-dynamic";

/** Two to four servers' load on shared axes. The pick and the range live in the
 *  address (?ids=local,<id>&range=7d), so a comparison can be linked to; anything
 *  in it that is not one of the reader's servers is dropped rather than refused. */
export default async function CompareServersPage({
    searchParams
}: {
    searchParams: Promise<{ ids?: string | string[]; range?: string | string[] }>;
}) {
    const user = await requirePermission("system.manage");
    const [rows, t, params] = await Promise.all([
        listServerRows(user.id),
        getTranslations("servers"),
        searchParams
    ]);
    const servers = rows.map((row) => ({ id: row.id, name: row.name }));
    const known = new Set(servers.map((server) => server.id));
    const asked =
        typeof params.ids === "string" ? params.ids.split(",").filter((id) => known.has(id)) : [];
    const initialIds = [...new Set(asked)].slice(0, COMPARE_MAX);
    const range =
        typeof params.range === "string" && (RANGE_ORDER as string[]).includes(params.range)
            ? (params.range as RangePreset)
            : "1d";
    return (
        <>
            <PageHeader title={t("compare.heading")} description={t("compare.description")} />
            <CompareView
                servers={servers}
                initialIds={
                    initialIds.length > 0
                        ? initialIds
                        : servers.slice(0, 2).map((server) => server.id)
                }
                initialRange={range}
            />
        </>
    );
}
