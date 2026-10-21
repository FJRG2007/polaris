/** Network filter, Local DNS (/apps/dns-blocker/local-dns). The layout carries the settings. */

import { requireAdmin } from "@/lib/session";
import { DnsLocalSection } from "../local-dns-section";

export const dynamic = "force-dynamic";

export default async function DnsBlockerLocalDnsPage() {
    await requireAdmin();
    return <DnsLocalSection />;
}
