/**
 * Analytics (/analytics): the overview of one site.
 *
 * Structured like the firewall and like Deploy, because it answers the same shape of
 * question about the same things: pick what you are looking at in the header, then
 * read down. Every other section is a route of its own beside this one, linked from
 * the rail; the address used to pick them with `?tab=`, and such a link is sent to
 * its route with the rest of its query intact.
 */

import { redirect } from "next/navigation";
import { renderAnalyticsPage, type AnalyticsSearch } from "./analytics-page";
import { analyticsTabPath, isAnalyticsTab, isReportTab } from "./analytics-tabs";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<AnalyticsSearch & { f?: string }> }) {
    const params = await searchParams;
    if (params.tab && isAnalyticsTab(params.tab) && params.tab !== "overview") {
        const query = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (typeof value !== "string") continue;
            if (key === "tab" && !isReportTab(value)) continue;
            query.set(key, value);
        }
        const rest = query.toString();
        redirect(`${analyticsTabPath(params.tab)}${rest ? `?${rest}` : ""}`);
    }
    return renderAnalyticsPage(Promise.resolve(params), "overview");
}
