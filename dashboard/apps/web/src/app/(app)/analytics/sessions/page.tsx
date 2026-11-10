import { renderAnalyticsPage, type AnalyticsSearch } from "../analytics-page";

export const dynamic = "force-dynamic";

/** Analytics, sessions: see `../analytics-page` for what every section resolves first. */
export default async function AnalyticsSessionsPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
    return renderAnalyticsPage(searchParams, "sessions");
}
