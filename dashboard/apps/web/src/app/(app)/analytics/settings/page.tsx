import { renderAnalyticsPage, type AnalyticsSearch } from "../analytics-page";

export const dynamic = "force-dynamic";

/** Analytics, settings: see `../analytics-page` for what every section resolves first. */
export default async function AnalyticsSettingsPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
    return renderAnalyticsPage(searchParams, "site");
}
