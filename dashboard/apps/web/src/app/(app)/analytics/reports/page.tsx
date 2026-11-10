import { renderAnalyticsPage, type AnalyticsSearch } from "../analytics-page";
import { isReportTab } from "../analytics-tabs";

export const dynamic = "force-dynamic";

/** Analytics, saved reports: funnels, journeys, goals, retention and revenue, by `?tab=`. */
export default async function AnalyticsReportsPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
    const params = await searchParams;
    return renderAnalyticsPage(Promise.resolve(params), isReportTab(params.tab) ? params.tab : "funnels");
}
