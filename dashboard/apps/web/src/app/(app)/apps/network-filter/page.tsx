/**
 * Network filter (/apps/network-filter): the Overview. A DNS server for the whole
 * network that leaves out ads, trackers and malware: where it stands, what it has
 * been doing, and what to type into the router. The other sections sit beside it
 * in the rail; the layout carries the settings and the install. Somebody the
 * statistics were shared with sees those and nothing else.
 */

import { homePathForUser, requireUser } from "@/lib/session";
import { redirect } from "next/navigation";
import { dnsFilterReach } from "@/lib/dns-blocker/access";
import { DnsHistoryCard } from "./history-card";
import { routerBrandsFor } from "@/lib/router-guide";
import { getTranslations } from "@/lib/i18n/request";
import { DnsOverviewSection } from "./overview-section";
import { routerGuideIn } from "@/app/(app)/admin/domains/router-words";

export const dynamic = "force-dynamic";

export default async function DnsBlockerPage() {
    const user = await requireUser();
    const reach = await dnsFilterReach(user);
    if (!reach) redirect(`${await homePathForUser(user)}?denied=1`);
    if (reach === "shared") return <DnsHistoryCard shared />;
    const tAdmin = await getTranslations("admin");
    const brands = routerBrandsFor("dns").map((entry) => ({
        value: entry.id,
        label: routerGuideIn(tAdmin, entry).label
    }));
    return <DnsOverviewSection brands={brands} />;
}
