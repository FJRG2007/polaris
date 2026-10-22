/** Network filter, Query log (/apps/network-filter/log). The layout carries the settings. */

import { requireAdmin } from "@/lib/session";
import { DnsLogSection } from "../log-section";

export const dynamic = "force-dynamic";

export default async function DnsBlockerLogPage() {
    await requireAdmin();
    return <DnsLogSection />;
}
