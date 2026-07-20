import { notFound } from "next/navigation";
import { serviceName } from "@polaris/deploy";
import { refreshCapabilities } from "@polaris/hostd-client";
import { requirePermission, userHasManage } from "@/lib/session";
import { getDeploymentStatuses, getProjectFull } from "@/lib/deploy-service";
import { ProjectDetail } from "../project-detail";
import type { ProjectSummary } from "../deploy-view";

export const dynamic = "force-dynamic";

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
                sourceType: app.sourceType,
                currentDeploymentId: app.currentDeploymentId,
                deployStatus: app.currentDeploymentId ? (statuses[app.currentDeploymentId] ?? null) : null,
                targetId: app.targetId,
                containerRef: serviceName(project.slug, app.slug, app.id),
                autoDeploy: app.autoDeploy,
                deployBranch: app.deployBranch,
                commitFilter: app.commitFilter,
                domains: app.domains.map((domain) => ({ id: domain.id, hostname: domain.hostname, kind: domain.kind }))
            })),
            databases: environment.databases.map((database) => ({
                id: database.id,
                name: database.name,
                engine: database.engine,
                status: database.status
            }))
        }))
    };

    return <ProjectDetail project={summary} canManage={canManage} localReady={localReady} />;
}
