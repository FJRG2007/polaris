import { notFound } from "next/navigation";
import type { AppDomain } from "../domain-rank";
import { ProjectDetail } from "../project-detail";
import { getPublicIp } from "@/lib/domain-service";
import type { ProjectSummary } from "../deploy-view";
import { servingReleases } from "@/lib/deploy/releases";
import { referenceEdges } from "@/lib/deploy/private-names";
import { capabilitiesFor } from "@/lib/host-capabilities";
import { projectAccess } from "@/lib/deploy-project-access";
import { serviceAttention } from "@/lib/deploy/project-glance";
import type { TunnelDomain } from "@/lib/deploy/tunnel-domains";
import { requirePermission, userHasManage } from "@/lib/session";
import { listActiveTunnelDomains } from "@/lib/deploy/tunnel-domains";
import { getApplicationDeployStatuses, getProjectFull, hostPortForApp } from "@/lib/deploy-service";

export const dynamic = "force-dynamic";

/** Append active tunnel hostnames to an app's domains, skipping any whose hostname
 *  is already a real Domain row so a named tunnel isn't listed twice. */
function mergeTunnelDomains(domains: AppDomain[], tunnels: TunnelDomain[]): AppDomain[] {
    const seen = new Set(domains.map((domain) => domain.hostname.toLowerCase()));
    return [...domains, ...tunnels.filter((tunnel) => !seen.has(tunnel.hostname))];
}

/** The container port stored in an app's source config, if any. */
function portOf(sourceConfig: string): number | null {
    try {
        const value = (JSON.parse(sourceConfig) as { port?: unknown }).port;
        return typeof value === "number" ? value : null;
    } catch {
        return null;
    }
}

/** A string field out of the stored source config (the repository paths a git service
 *  builds from), or null when it is unset or the config will not parse. */
/** A string setting out of one of the stored JSON blobs, or null when unset. */
function storedText(json: string, key: string): string | null {
    try {
        const value = (JSON.parse(json) as Record<string, unknown>)[key];
        return typeof value === "string" && value ? value : null;
    } catch {
        return null;
    }
}

function pick(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

export default async function DeployProjectPage({
    params,
    searchParams
}: {
    params: Promise<{ projectId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const [{ projectId }, query, user] = await Promise.all([
        params,
        searchParams,
        requirePermission("deploy.read")
    ]);
    // Three reads that need nothing from one another, taken together.
    const [canManage, project, access] = await Promise.all([
        userHasManage(user, "deploy.manage"),
        getProjectFull(projectId, user.id),
        projectAccess(projectId, user.id)
    ]);
    if (!project) notFound();

    // An entry may be written for some of the project's environments only, which
    // is how somebody works in development and not in production. Filtered here
    // rather than in the view: what is not theirs to reach should never have been
    // sent to their browser in the first place.
    if (!access) notFound();
    if (access.environmentIds !== null) {
        const reachable = new Set(access.environmentIds);
        project.environments = project.environments.filter((environment) =>
            reachable.has(environment.id)
        );
    }

    const allApps = project.environments.flatMap((environment) => environment.applications);
    const appIds = allApps.map((app) => app.id);
    // Everything below reads only the (filtered) project, so none of it waits on
    // another. A service that keeps its history is served by the release it
    // currently points at, which has a container name and a published port of its
    // own - so the terminal, the file browser and the direct IP:port link all have
    // to follow it.
    const [caps, statuses, serverIp, tunnelDomains, attention, serving, references] = await Promise.all([
        canManage ? capabilitiesFor("deploy") : null,
        getApplicationDeployStatuses(
            allApps.map((app) => ({ id: app.id, currentDeploymentId: app.currentDeploymentId }))
        ),
        getPublicIp(),
        listActiveTunnelDomains(appIds),
        serviceAttention(appIds),
        servingReleases(allApps.map((app) => ({ ...app, environment: { project } }))),
        // Only the edges leave the server; the variables they come from never do.
        referenceEdges(project.environments.map((environment) => environment.id))
    ]);
    const localReady = Boolean(caps?.deploy);

    const summary: ProjectSummary = {
        id: project.id,
        name: project.name,
        environments: project.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            isDefault: environment.isDefault,
            layout: environment.layout,
            referenceEdges: references.get(environment.id) ?? [],
            applications: environment.applications.map((app) => ({
                id: app.id,
                name: app.name,
                environmentId: environment.id,
                sourceType: app.sourceType,
                currentDeploymentId: app.currentDeploymentId,
                // What the service is doing now: the build in flight, or the release
                // it serves. Null only when it has never been deployed.
                deployStatus: statuses[app.id] ?? null,
                targetId: app.targetId,
                serverId:
                    app.target.kind === "local" || !app.target.hostId ? "local" : app.target.hostId,
                serverName: app.target.name,
                containerRef: serving.get(app.id)?.name ?? "",
                autoDeploy: app.autoDeploy,
                deployBranch: app.deployBranch,
                commitFilter: app.commitFilter,
                watchPaths: app.watchPaths,
                keepReleases: app.keepReleases,
                rootDirectory: storedText(app.sourceConfig, "rootDirectory"),
                dockerfilePath: storedText(app.sourceConfig, "dockerfilePath"),
                installCommand: storedText(app.buildConfig, "installCommand"),
                buildCommand: storedText(app.buildConfig, "buildCommand"),
                startCommand: storedText(app.buildConfig, "startCommand"),
                runtimeVersion: storedText(app.buildConfig, "runtimeVersion"),
                outputDirectory: storedText(app.buildConfig, "outputDirectory"),
                replicas: app.replicas,
                port: portOf(app.sourceConfig),
                // None for a service whose port is kept closed: it has no address of
                // its own on the machine, only its domains. A kept release is still
                // reached on its own port, whatever the setting.
                ipUrl:
                    serverIp &&
                    (app.publishPort || (serving.get(app.id)?.portSubject ?? app.id) !== app.id)
                        ? `http://${serverIp}:${hostPortForApp(serving.get(app.id)?.portSubject ?? app.id)}`
                        : null,
                domains: mergeTunnelDomains(
                    // A per-release hostname belongs to one build, not to the service, so
                    // it is listed on that deployment rather than among the service's own
                    // addresses.
                    app.domains
                        .filter((domain) => domain.kind !== "release")
                        .map((domain) => ({
                            id: domain.id,
                            hostname: domain.hostname,
                            kind: domain.kind,
                            enabled: domain.enabled,
                            healthStatus: domain.healthStatus,
                            healthCode: domain.healthCode,
                            healthDetail: domain.healthDetail,
                            // Whether one was supplied, never the material itself: the
                            // panel only needs to say which certificate is in use.
                            hasCertificate: domain.certPem !== null,
                            servedBy: domain.servedBy,
                            cdn: domain.cdn
                        })),
                    tunnelDomains.get(app.id) ?? []
                ),
                volumes: app.volumes.map((volume) => ({
                    id: volume.id,
                    name: volume.name,
                    kind: volume.kind,
                    source: volume.source ?? volume.name,
                    mountPath: volume.mountPath,
                    connectionId: volume.connectionId,
                    connectionName: volume.connection?.name ?? null,
                    sizeLimit: volume.sizeLimit
                })),
                attention: attention.get(app.id)
            })),
            databases: environment.databases.map((database) => ({
                id: database.id,
                name: database.name,
                engine: database.engine,
                status: database.status,
                hostedOnInstance: database.parentId !== null,
                hostedCount: database._count.children
            }))
        }))
    };

    // Both are only ever matched against this project's own ids, so an id that
    // belongs to nobody (or to another project) simply opens the default view.
    return (
        <ProjectDetail
            project={summary}
            canManage={canManage}
            capabilities={access.capabilities}
            localReady={localReady}
            activeEnvironmentId={pick(query.env)}
            openService={pick(query.service)}
        />
    );
}
