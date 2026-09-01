import { PageHeader } from "@polaris/ui";
import { ServersView } from "./servers-view";
import { listServerRows } from "./server-rows";
import { requirePermission } from "@/lib/session";
import { localMachineNameNow } from "@/lib/local-server";

export const dynamic = "force-dynamic";

/**
 * Everything the table needs is a database or settings read, so it is on screen
 * at once. Whether each server answers needs a socket per server, and that
 * arrives from /api/servers/status after the page has painted.
 *
 * What the local machine calls itself used to arrive with it, and drew a skeleton
 * in the meantime - a loading state for a fact that does not change, under the
 * name of the machine it was about. The hostname is a syscall and is what the
 * engine reports on essentially every deployment, so it is rendered now and
 * corrected by the live answer if the two ever differ.
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
            <ServersView servers={servers} machineName={localMachineNameNow()} />
        </>
    );
}
