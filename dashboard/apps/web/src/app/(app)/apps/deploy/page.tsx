import { PageHeader } from "@polaris/ui";
import { refreshCapabilities } from "@polaris/hostd-client";
import { requirePermission, userHasManage } from "@/lib/session";
import { getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { listProjects } from "@/lib/deploy-service";
import { DeployView, type ProjectSummary } from "./deploy-view";

export const dynamic = "force-dynamic";

export default async function DeployPage() {
    const user = await requirePermission("deploy.read");
    const canManage = await userHasManage(user, "deploy.manage");

    // Seed the local target so the first deploy needs no server setup, and report
    // whether the local host can actually build/deploy (full edition + daemon).
    if (canManage) await getOrCreateLocalTarget(user.id);
    const caps = canManage ? await refreshCapabilities() : null;
    const localReady = Boolean(caps?.deploy);

    const projects: ProjectSummary[] = (await listProjects(user.id)).map((project) => ({
        id: project.id,
        name: project.name,
        environments: project.environments.map((environment) => ({
            id: environment.id,
            name: environment.name,
            applications: environment.applications.map((app) => ({
                id: app.id,
                name: app.name,
                sourceType: app.sourceType,
                currentDeploymentId: app.currentDeploymentId,
                domains: app.domains.map((domain) => ({ id: domain.id, hostname: domain.hostname, kind: domain.kind }))
            })),
            databases: environment.databases.map((database) => ({
                id: database.id,
                name: database.name,
                engine: database.engine,
                status: database.status
            }))
        }))
    }));

    return (
        <>
            <PageHeader
                title="Deploy"
                description="Deploy apps and databases across your local host and remote servers."
            />
            <DeployView projects={projects} canManage={canManage} localReady={localReady} />
        </>
    );
}
