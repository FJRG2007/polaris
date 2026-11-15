/**
 * A site's numbers by its public link, framed by another site
 * (/sa/embed/<token>). The only analytics address sent without frame headers
 * (`next.config.mjs`); it opens only for a link made to be embedded. See
 * `../../shared-analytics`.
 */

import type { Metadata } from "next";
import { SharedAnalytics } from "../../shared-analytics";
import { getTranslations } from "@/lib/i18n/request";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
    return { title: (await getTranslations("analytics"))("report.title") };
}

export default async function SharedAnalyticsEmbed({
    params,
    searchParams
}: {
    params: Promise<{ token: string }>;
    searchParams: Promise<{ range?: string | string[] }>;
}) {
    const [{ token }, query] = await Promise.all([params, searchParams]);
    const range = typeof query.range === "string" ? query.range : undefined;
    return <SharedAnalytics token={token} rangeParam={range} embed />;
}
