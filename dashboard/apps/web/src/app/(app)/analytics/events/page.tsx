import { renderAnalyticsPage, type AnalyticsSearch } from "../analytics-page";

export const dynamic = "force-dynamic";

/** Analytics, events: see `../analytics-page` for what every section resolves first. */
export default async function AnalyticsEventsPage({ searchParams }: { searchParams: Promise<AnalyticsSearch> }) {
    return renderAnalyticsPage(searchParams, "events");
}
