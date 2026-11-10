import { renderAnalyticsPage, type AnalyticsSearch } from "../analytics-page";

export const dynamic = "force-dynamic";

/** Analytics, geography: see `../analytics-page` for what every section resolves first. */
export default async function AnalyticsGeographyPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
    return renderAnalyticsPage(searchParams, "geography");
}
