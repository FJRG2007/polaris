/**
 * A site's numbers over a window, as a report on paper
 * (/analytics/report?scopeType=&scopeId=&range=&filters=).
 *
 * In the print route group so none of the app is drawn around it. It reads
 * the same report the overview draws, through the same access check, so what
 * is printed is what the reader could already see; a site that is not theirs
 * is the same not-found as one that does not exist. The browser's own
 * "Save as PDF" turns it into the file.
 */

import { z } from "zod";
import type { Metadata } from "next";
import * as core from "@polaris/core";
import { notFound } from "next/navigation";
import { ReportView } from "./report-view";
import { userHasManage } from "@/lib/session";
import { getTranslations } from "@/lib/i18n/request";
import { Messages } from "@/components/i18n/messages";
import { readAnalytics } from "@/lib/analytics-service";
import { siteAccess } from "@/app/(app)/analytics/site-access";
import { DisplayFormatProvider } from "@/components/display-format";
import { requireAnalyticsReader } from "@/app/(app)/analytics/reader";
import { resolveDisplayPreferencesFor } from "@/lib/display-prefs-service";

export const dynamic = "force-dynamic";

const querySchema = z.object({
    scopeType: z.enum(["application", "polaris", "external"]),
    scopeId: z.string().max(64),
    range: core.visitRangeSchema,
    filters: z.string().max(4000).optional()
});

export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("analytics"))("report.title") };
}

export default async function AnalyticsReportPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
    const { user } = await requireAnalyticsReader();
    const query = querySchema.safeParse(await searchParams);
    if (!query.success) notFound();
    const isOperator = await userHasManage(user, "system.manage");
    const access = await siteAccess(user.id, isOperator, query.data.scopeType, query.data.scopeId);
    if (!access) notFound();
    const filters = core.parseVisitFilters(query.data.filters);
    const [view, display] = await Promise.all([
        readAnalytics(access.site, query.data.range, Date.now(), filters),
        resolveDisplayPreferencesFor(user.id)
    ]);
    return (
        <DisplayFormatProvider preferences={display}>
            <Messages namespaces={["analytics"]}>
                <ReportView
                    name={access.site.name}
                    range={query.data.range}
                    filters={filters}
                    from={view.from}
                    to={view.to}
                    overview={view.overview}
                    series={view.series}
                    breakdowns={view.breakdowns}
                    unavailable={view.unavailable}
                    filtersIgnored={view.filtersIgnored}
                />
            </Messages>
        </DisplayFormatProvider>
    );
}
