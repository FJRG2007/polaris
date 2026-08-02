import { notFound } from "next/navigation";
import { LogsView } from "../../logs-view";
import { requirePermission } from "@/lib/session";
import { getProjectFull } from "@/lib/deploy-service";
import { requireProjectAccess } from "@/lib/deploy-project-access";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

/** Every service's runtime output in one place, for the environment on screen. */
export default async function ProjectLogsPage({
    params,
    searchParams
}: {
    params: Promise<{ projectId: string }>;
    searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
    const { projectId } = await params;
    const query = await searchParams;
    const user = await requirePermission("deploy.read");

    try {
        await requireProjectAccess(projectId, user.id, "viewer");
    } catch {
        notFound();
    }

    const project = await getProjectFull(projectId, user.id);
    if (!project) notFound();

    const requested = pick(query.env);
    const environment =
        project.environments.find((entry) => entry.id === requested) ??
        project.environments.find((entry) => entry.isDefault) ??
        project.environments[0];

    return (
        <LogsView
            environmentName={environment?.name ?? "production"}
            services={(environment?.applications ?? []).map((app) => ({
                id: app.id,
                name: app.name,
                running: Boolean(app.currentDeploymentId)
            }))}
        />
    );
}
