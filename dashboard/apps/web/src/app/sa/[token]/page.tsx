/** A site's numbers by its public link (/sa/<token>); see `../shared-analytics`. */

import type { Metadata } from "next";
import { SharedAnalytics } from "../shared-analytics";
import { getTranslations } from "@/lib/i18n/request";
import { linkPreviewMetadata } from "@/lib/link-preview/metadata";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function generateMetadata({
    params
}: {
    params: Promise<{ token: string }>;
}): Promise<Metadata> {
    return {
        title: (await getTranslations("analytics"))("report.title"),
        ...(await linkPreviewMetadata("analytics", (await params).token))
    };
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
