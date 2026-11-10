/**
 * Analytics, websites (/analytics/sites): every site this account can open - the
 * services it runs here, the sites it added from elsewhere, and Polaris itself for
 * an operator - with the way to add another.
 */

import { SitesView } from "./sites-view";
import { requireAnalyticsReader } from "../reader";
import { requireInstalledApp } from "@/lib/apps/require-installed";

export const dynamic = "force-dynamic";

export default async function AnalyticsSitesPage() {
    const { user, lent } = await requireAnalyticsReader();
    await requireInstalledApp("analytics", user);
    return <SitesView canAdd={lent === null} />;
}
