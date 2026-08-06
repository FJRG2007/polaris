import "server-only";

/**
 * Which Docker hosts a person can reach, resolved once for every screen in the
 * Containers app.
 *
 * Three things are hosts here and none of them look alike: the local engine
 * brokered by the daemon, a server registered in the Servers app reached over
 * SSH, and a Docker connection somebody stored by hand. Working out that set -
 * and, more delicately, that the local engine and one of those servers are the
 * same machine under two names - is the same job for the list and for one
 * container's page, so it is done here rather than twice.
 *
 * Nothing in here talks to a Docker engine. It answers from the database and
 * from hostd's own capability report, which is what lets both pages paint before
 * a possibly-remote engine has said anything.
 */

import { listHosts } from "@/lib/host-service";
import type { DockerTransport } from "@polaris/docker";
import { refreshCapabilities } from "@polaris/hostd-client";
import { userHasManage, type SessionUser } from "@/lib/session";
import { isLocalMachine, localDockerId } from "@/lib/local-machine";
import type { DockerConnectionSummary, LocalHostDiagnostic } from "./types";
import { HOST_DOCKER_PREFIX, listDockerConnections, LOCAL_DOCKER_CONNECTION_ID } from "@/lib/docker-service";

export interface ContainerHosts {
    connections: DockerConnectionSummary[];
    /** Whether this person may manage the system, which is what the local engine
     *  and every lifecycle control are gated on. */
    canManage: boolean;
    /** Why the local host is missing, for an admin who should have one. */
    localDiagnostic: LocalHostDiagnostic | null;
}

export async function containerHosts(user: SessionUser): Promise<ContainerHosts> {
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
    // A registered server can be the very machine Polaris runs on. Offering both
    // is one engine under two names, listing the same containers twice - so when
    // the local host is on the menu, that server is it, under its own name. It
    // still appears on its own when the local host is not offered, which is what
    // keeps an operator who may not manage the system able to reach it.
    const hosts = await listHosts(user.id);
    const localId = await localDockerId();
    const sameMachine = localAvailable ? (hosts.find((host) => isLocalMachine(host, localId)) ?? null) : null;

    const localHost: DockerConnectionSummary[] = localAvailable
        ? [
              {
                  id: LOCAL_DOCKER_CONNECTION_ID,
                  name: sameMachine?.name ?? "Local host",
                  transport: "socket",
                  status: "active",
                  local: true
              }
          ]
        : [];
    // Global Hosts (managed in the Servers app) appear here as Docker-over-SSH
    // targets - a server registered once is usable in Containers too.
    const hostTargets: DockerConnectionSummary[] = hosts
        .filter((host) => host.id !== sameMachine?.id)
        .map((host) => ({
            id: `${HOST_DOCKER_PREFIX}${host.id}`,
            name: host.name,
            transport: "ssh",
            status: host.status,
            host: true
        }));

    return { connections: [...localHost, ...stored, ...hostTargets], canManage, localDiagnostic };
}

/** The host a request named, or the one it lands on instead. A person who forced
 *  ?c=local into the URL without the permission for it gets the first host they
 *  can actually reach, not a denial for a host they were never shown. */
export function selectConnection(
    hosts: ContainerHosts,
    requested: string | undefined
): DockerConnectionSummary | null {
    const selectable = hosts.connections.filter((connection) => !connection.local || hosts.canManage);
    return selectable.find((connection) => connection.id === requested) ?? selectable[0] ?? null;
}
