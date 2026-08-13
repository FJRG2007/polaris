import type { ServiceKind } from "./deploy-view";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { isInFlightStatus } from "@/lib/deploy/status";
import { refreshCapabilities } from "@polaris/hostd-client";
import { requirePermission, userHasManage } from "@/lib/session";
import { getOrCreateLocalTarget } from "@/lib/deploy-target-service";
import { ProjectsGrid, type ProjectCardData } from "./projects-grid";
import { getApplicationDeployStatuses, listProjects } from "@/lib/deploy-service";

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
    const shown = projects.map((project) => ({
        project,
        environment: project.environments.find((environment) => environment.isDefault) ?? project.environments[0]
    }));
    // Live status per service, so a card counts what is actually up rather than what
    // has ever been deployed, and can say a build is running before it has a release.
    const statuses = await getApplicationDeployStatuses(
        shown.flatMap(({ environment }) =>
            (environment?.applications ?? []).map((app) => ({ id: app.id, currentDeploymentId: app.currentDeploymentId }))
        )
    );
    const cards: ProjectCardData[] = shown.map(({ project, environment }) => {
        const apps = environment?.applications ?? [];
        const databases = environment?.databases ?? [];
        const services: ServiceKind[] = [
            ...apps.map((app): ServiceKind => (app.sourceType === "image" ? "image" : "github")),
            ...databases.map((): ServiceKind => "database")
        ];
        const online =
            apps.filter((app) => ONLINE_DB_STATES.has((statuses[app.id] ?? "").toLowerCase())).length +
            databases.filter((database) => ONLINE_DB_STATES.has(database.status.toLowerCase())).length;
        return {
            id: project.id,
            name: project.name,
            environmentName: environment?.name ?? "production",
            services,
            online,
            deploying:
                apps.filter((app) => isInFlightStatus(statuses[app.id])).length +
                databases.filter((database) => isInFlightStatus(database.status)).length,
            total: apps.length + databases.length
        };
    });

    return (
        <ProjectsGrid projects={cards} canManage={canManage} localReady={localReady} />
    );
}
