/** A site's numbers by its public link (/sa/<token>); see `../shared-analytics`. */

import type { Metadata } from "next";
import { SharedAnalytics } from "../shared-analytics";
import { getTranslations } from "@/lib/i18n/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("analytics"))("report.title") };
}

export default async function SharedAnalyticsPage({
    params,
    searchParams
}: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ range?: string | string[] }>;
}) {
    const [{ token }, query] = await Promise.all([params, searchParams]);
    const range = typeof query.range === "string" ? query.range : undefined;
    return <SharedAnalytics token={token} rangeParam={range} embed={false} />;
}
