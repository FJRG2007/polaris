import { PageHeader } from "@polaris/ui";
import { loadEnv } from "@polaris/config";
import { listHosts } from "@/lib/host-service";
import { ContainersView } from "./containers-view";
import type { DockerTransport } from "@polaris/docker";
import { requireUser, userHasManage } from "@/lib/session";
import { refreshCapabilities } from "@polaris/hostd-client";
import type { DockerConnectionSummary, LocalHostDiagnostic } from "./types";
import { HOST_DOCKER_PREFIX, listDockerConnections, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/**
 * The Containers shell. Only what the page needs to draw itself is resolved
 * here - which hosts exist, which one is selected, whether the caller may manage
 * them - so the navigation paints immediately. The engine itself (an overview, a
 * container list and a stats sample each) is fetched by the view from
 * /api/containers, because that round trip can cross a network and must not sit
 * in front of the first paint.
 */
export default async function ContainersPage({
    searchParams
}: {
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const user = await requireUser();
    const params = await searchParams;
    const sshEnabled = loadEnv().POLARIS_SSH_ENABLED;

    // The local host is host-wide, so it is only offered to operators who may
    // manage the system, and only in the full edition (hostd reports docker).
    // Probe the daemon directly here rather than trusting the cached snapshot, so
    // the local host shows the moment hostd reports Docker - no dependence on the
    // background refresh having run, and no up-to-30s blind spot after a restart.
    const canManage = await userHasManage(user, "system.manage");
    const caps = canManage ? await refreshCapabilities() : null;
    const localAvailable = Boolean(caps?.docker);

    // When an admin has no local host, explain WHY (edition / hostd / socket) so
    // it is diagnosable instead of a silent "connect a host" prompt.
    const localDiagnostic: LocalHostDiagnostic | null =
        canManage && caps && !caps.docker
            ? {
                  edition: caps.edition,
                  hostdPresent: caps.hostd.present,
                  hostdVersion: caps.hostd.version,
                  dockerReported: caps.docker,
                  reason: !caps.hostd.present
                      ? "polaris-hostd (the privileged host daemon) is not answering, so Polaris is in the limited edition. The local Docker host needs the full edition: re-run the installer (full is the default) and check that a `polaris-hostd` service shows in `docker compose ps` - if it is missing, COMPOSE_PROFILES=full is not set in your .env."
                      : "The host daemon is running but reports no Docker socket. Make sure /var/run/docker.sock is mounted into the polaris-hostd container (it is by default in docker/docker-compose.yml)."
              }
            : null;

    const stored: DockerConnectionSummary[] = (await listDockerConnections(user.id)).map((row) => ({
        id: row.id,
        name: row.name,
        transport: row.transport as DockerTransport,
        status: row.status
    }));
    const localHost: DockerConnectionSummary[] = localAvailable
        ? [{ id: LOCAL_DOCKER_CONNECTION_ID, name: "Local host", transport: "socket", status: "active", local: true }]
        : [];
    // Global Hosts (managed in the Servers app) appear here as Docker-over-SSH
    // targets - a server registered once is usable in Containers too.
    const hostTargets: DockerConnectionSummary[] = (await listHosts(user.id)).map((host) => ({
        id: `${HOST_DOCKER_PREFIX}${host.id}`,
        name: host.name,
        transport: "ssh",
        status: host.status,
        host: true
    }));
    const connections = [...localHost, ...stored, ...hostTargets];

    const requested = pick(params.c);
    // A non-manager who forced ?c=local via the URL gets the first host they can
    // actually reach, not a denial for a host they were never shown.
    const selectable = connections.filter((connection) => !connection.local || canManage);
    const connectionId =
        selectable.find((connection) => connection.id === requested)?.id ?? selectable[0]?.id ?? null;

    return (
        <>
            <PageHeader
                title="Containers"
                description="Monitor and manage Docker across your hosts - usage, state, and lifecycle."
            />
            <ContainersView
                connections={connections}
                connectionId={connectionId}
                sshEnabled={sshEnabled}
                canManage={canManage}
                localDiagnostic={localDiagnostic}
            />
        </>
    );
}
