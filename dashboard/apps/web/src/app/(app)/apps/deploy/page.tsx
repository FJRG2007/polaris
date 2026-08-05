import type { ServiceKind } from "./deploy-view";
import { listProjects } from "@/lib/deploy-service";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { refreshCapabilities } from "@polaris/hostd-client";
import { requirePermission, userHasManage } from "@/lib/session";
import { getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { ProjectsGrid, type ProjectCardData } from "./projects-grid";

export const dynamic = "force-dynamic";

const ONLINE_DB_STATES = new Set(["running", "active", "healthy", "ready"]);

export default async function DeployPage() {
    const user = await requirePermission("deploy.read");
    const canManage = await userHasManage(user, "deploy.manage");

    // Seed the local target so the first deploy needs no server setup, and report
    // whether the local host can actually build/deploy (full edition + daemon).
    if (canManage) await getOrCreateLocalTarget(user.id);
    const caps = canManage ? await refreshCapabilities() : null;
    const localReady = Boolean(caps?.deploy);

    // The shelf that is open decides what is listed: your own services, or the
    // organization's. A project never appears on both.
    const projects = await listProjects(user.id, await scopeOrgIdFor(user.id));
    const cards: ProjectCardData[] = projects.map((project) => {
        const env = project.environments.find((environment) => environment.isDefault) ?? project.environments[0];
        const apps = env?.applications ?? [];
        const databases = env?.databases ?? [];
        const services: ServiceKind[] = [
            ...apps.map((app): ServiceKind => (app.sourceType === "image" ? "image" : "github")),
            ...databases.map((): ServiceKind => "database")
        ];
        const online =
            apps.filter((app) => app.currentDeploymentId).length +
            databases.filter((database) => ONLINE_DB_STATES.has(database.status.toLowerCase())).length;
        return {
            id: project.id,
            name: project.name,
            environmentName: env?.name ?? "production",
            services,
            online,
            total: apps.length + databases.length
        };
    });

    return (
        <ProjectsGrid projects={cards} canManage={canManage} localReady={localReady} />
    );
}
