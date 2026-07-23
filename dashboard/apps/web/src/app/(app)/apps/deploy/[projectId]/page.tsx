import { notFound } from "next/navigation";
import { serviceName } from "@polaris/deploy";
import { refreshCapabilities } from "@polaris/hostd-client";
import { requirePermission, userHasManage } from "@/lib/session";
import { getDeploymentStatuses, getProjectFull, hostPortForApp, listProjects } from "@/lib/deploy-service";
import { listActiveTunnelDomains } from "@/lib/deploy/tunnel-domains";
import { getPublicIp } from "@/lib/domain-service";
import type { TunnelDomain } from "@/lib/deploy/tunnel-domains";
import { ProjectDetail } from "../project-detail";
import type { AppDomain, ProjectSummary } from "../deploy-view";

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

export default async function DeployProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
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
    const allProjects = (await listProjects(user.id)).map((item) => ({ id: item.id, name: item.name }));
    const serverIp = await getPublicIp();
    const appIds = project.environments.flatMap((environment) => environment.applications.map((app) => app.id));
    const tunnelDomains = await listActiveTunnelDomains(appIds);

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
                containerRef: serviceName(project.slug, app.slug, app.id),
                autoDeploy: app.autoDeploy,
                deployBranch: app.deployBranch,
                commitFilter: app.commitFilter,
                keepReleases: app.keepReleases,
                port: portOf(app.sourceConfig),
                ipUrl: serverIp ? `http://${serverIp}:${hostPortForApp(app.id)}` : null,
                domains: mergeTunnelDomains(
                    app.domains.map((domain) => ({
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
                status: database.status
            }))
        }))
    };

    return <ProjectDetail project={summary} projects={allProjects} canManage={canManage} localReady={localReady} />;
}
