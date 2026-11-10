/**
 * Analytics, add a site (/analytics/sites/new): the guided setup, for a service
 * deployed here or for a site that is not.
 */

import { redirect } from "next/navigation";
import { AddSiteFlow } from "./add-site-flow";
import { requireAnalyticsReader } from "@/app/(app)/analytics/reader";
import { requireInstalledApp } from "@/lib/apps/require-installed";

export const dynamic = "force-dynamic";

export default async function AnalyticsAddSitePage() {
    const { user, lent } = await requireAnalyticsReader();
    await requireInstalledApp("analytics", user);
    // Somebody who reads only what was shared with them has nothing to add.
    if (lent) redirect("/analytics/sites");
    return <AddSiteFlow />;
}
