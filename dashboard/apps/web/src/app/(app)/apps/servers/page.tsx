import { PageHeader } from "@polaris/ui";
import { requireUser } from "@/lib/session";
import { listHosts } from "@/lib/host-service";
import { ServersView, type HostSummary } from "./servers-view";

export const dynamic = "force-dynamic";

export default async function ServersPage() {
    const user = await requireUser();
    const hosts: HostSummary[] = (await listHosts(user.id)).map((host) => ({
        id: host.id,
        name: host.name,
        address: host.address,
        port: host.port,
        username: host.username,
        authMethod: host.authMethod,
        status: host.status
    }));

    return (
        <>
            <PageHeader
                title="Servers"
                description="SSH hosts registered once and reused across Containers (Docker) and Drive (SFTP)."
            />
            <ServersView hosts={hosts} />
        </>
    );
}
