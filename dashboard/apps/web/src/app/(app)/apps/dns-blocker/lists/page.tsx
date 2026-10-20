/** Ad blocker, Lists (/apps/dns-blocker/lists). The layout carries the settings. */

import { requireAdmin } from "@/lib/session";
import { DnsListsSection } from "../lists-section";

export const dynamic = "force-dynamic";

export default async function DnsBlockerListsPage() {
    await requireAdmin();
    return <DnsListsSection />;
}
