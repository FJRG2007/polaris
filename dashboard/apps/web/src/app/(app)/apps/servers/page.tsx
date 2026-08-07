import { PageHeader } from "@polaris/ui";
import { ServersView } from "./servers-view";
import { listServerRows } from "./server-rows";
import { requirePermission } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Everything the table needs is a database or settings read, so it is on screen
 * at once. What the local machine calls itself needs the container engine, and
 * whether each server answers needs a socket per server; both arrive from
 * /api/servers/status after the page has painted.
 */
export default async function ServersPage() {
    const user = await requirePermission("system.manage");
    const servers = await listServerRows(user.id);

    return (
        <>
            <PageHeader
                title="Servers"
                description="The box Polaris runs on and every SSH host it manages, reused across Containers (Docker) and Drive (SFTP)."
            />
            <ServersView servers={servers} />
        </>
    );
}
