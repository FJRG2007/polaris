/**
 * Network filter (/apps/dns-blocker): the Overview. A DNS server for the whole
 * network that leaves out ads, trackers and malware: where it stands, what it has
 * been doing, and what to type into the router. The other sections sit beside it
 * in the rail; the layout carries the settings and the install.
 */

import { requireAdmin } from "@/lib/session";
import { routerBrandsFor } from "@/lib/router-guide";
import { getTranslations } from "@/lib/i18n/request";
import { DnsOverviewSection } from "./overview-section";
import { routerGuideIn } from "@/app/(app)/admin/domains/router-words";

export const dynamic = "force-dynamic";

export default async function DnsBlockerPage() {
    await requireAdmin();
    const tAdmin = await getTranslations("admin");
    const brands = routerBrandsFor("dns").map((entry) => ({
        value: entry.id,
        label: routerGuideIn(tAdmin, entry).label
    }));
    return <DnsOverviewSection brands={brands} />;
}
