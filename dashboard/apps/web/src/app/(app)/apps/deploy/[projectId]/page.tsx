import { notFound } from "next/navigation";
import type { AppDomain } from "../domain-rank";
import { ProjectDetail } from "../project-detail";
import { getPublicIp } from "@/lib/domain-service";
import type { ProjectSummary } from "../deploy-view";
import { currentReleaseRef } from "@/lib/deploy/releases";
import { refreshCapabilities } from "@polaris/hostd-client";
import type { TunnelDomain } from "@/lib/deploy/tunnel-domains";
import { requirePermission, userHasManage } from "@/lib/session";
import { listActiveTunnelDomains } from "@/lib/deploy/tunnel-domains";
import { getDeploymentStatuses, getProjectFull, hostPortForApp } from "@/lib/deploy-service";

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
function sourceText(sourceConfig: string, key: "rootDirectory" | "dockerfilePath"): string | null {
    try {
        const value = (JSON.parse(sourceConfig) as Record<string, unknown>)[key];
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
    const { projectId } = await params;
    const query = await searchParams;
    const user = await requirePermission("deploy.read");
    const canManage = await userHasManage(user, "deploy.manage");

    const project = await getProjectFull(projectId, user.id);
    if (!project) notFound();

    const caps = canManage ? await refreshCapabilities() : null;
    const localReady = Boolean(caps?.deploy);

    const deploymentIds = project.environments.flatMap((environment) =>
        environment.applications.map((app) => app.currentDeploymentId).filter((id): id is string => Boolean(id))
    );
    const statuses = await getDeploymentStatuses(deploymentIds);
    const serverIp = await getPublicIp();
    const appIds = project.environments.flatMap((environment) => environment.applications.map((app) => app.id));
    const tunnelDomains = await listActiveTunnelDomains(appIds);
    // A service that keeps its history is served by the release it currently points
    // at, which has a container name and a published port of its own - so the
    // terminal, the file browser and the direct IP:port link all have to follow it.
    const allApps = project.environments.flatMap((environment) => environment.applications);
    const serving = new Map(
        await Promise.all(
            allApps.map(async (app) => [app.id, await currentReleaseRef({ ...app, environment: { project } })] as const)
        )
    );

    const summary: ProjectSummary = {
        id: project.id,
        name: project.name,
        environments: project.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            isDefault: environment.isDefault,
            layout: environment.layout,
            applications: environment.applications.map((app) => ({
                id: app.id,
                name: app.name,
                environmentId: environment.id,
                sourceType: app.sourceType,
                currentDeploymentId: app.currentDeploymentId,
                deployStatus: app.currentDeploymentId ? (statuses[app.currentDeploymentId] ?? null) : null,
                targetId: app.targetId,
                serverId: app.target.kind === "local" || !app.target.hostId ? "local" : app.target.hostId,
                serverName: app.target.name,
                containerRef: serving.get(app.id)?.name ?? "",
                autoDeploy: app.autoDeploy,
                deployBranch: app.deployBranch,
                commitFilter: app.commitFilter,
                watchPaths: app.watchPaths,
                keepReleases: app.keepReleases,
                rootDirectory: sourceText(app.sourceConfig, "rootDirectory"),
                dockerfilePath: sourceText(app.sourceConfig, "dockerfilePath"),
                port: portOf(app.sourceConfig),
                ipUrl: serverIp ? `http://${serverIp}:${hostPortForApp(serving.get(app.id)?.portSubject ?? app.id)}` : null,
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
                            healthDetail: domain.healthDetail
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
                }))
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
            localReady={localReady}
            activeEnvironmentId={pick(query.env)}
            openService={pick(query.service)}
        />
    );
}
