import { renderAnalyticsPage, type AnalyticsSearch } from "../analytics-page";

export const dynamic = "force-dynamic";

/** Analytics, sources: see `../analytics-page` for what every section resolves first. */
export default async function AnalyticsSourcesPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
    return renderAnalyticsPage(searchParams, "sources");
}
