import { requirePermission } from "@/lib/session";
import { hostSubject } from "@/lib/metrics-shared";
import { listServerRows } from "@/app/(app)/apps/servers/server-rows";
import { UpsListView } from "./ups-list-view";

export const dynamic = "force-dynamic";

/** Every UPS Polaris watches. The machines are named from the database; what
 *  each UPS says arrives after the page has painted. */
export default async function UpsPage() {
    const user = await requirePermission("system.manage");
    const rows = await listServerRows(user.id);
    return (
        <UpsListView machines={rows.map((row) => ({ id: hostSubject(row.id), name: row.name }))} />
    );
}
