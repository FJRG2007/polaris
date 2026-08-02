import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { getProjectFull } from "@/lib/deploy-service";
import { ObservabilityView } from "../../observability-view";
import { requireProjectAccess } from "@/lib/deploy-project-access";

export const dynamic = "force-dynamic";

function pick(value: string | string[] | undefined): string | null {
    return (Array.isArray(value) ? value[0] : value) ?? null;
}

/**
 * Observability for one environment: what every service in it is doing, in one
 * screen, rather than one service at a time behind a panel.
 */
export default async function ObservabilityPage({
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
        <ObservabilityView
            environmentName={environment?.name ?? "production"}
            services={(environment?.applications ?? []).map((app) => ({
                id: app.id,
                name: app.name,
                running: Boolean(app.currentDeploymentId)
            }))}
            databases={(environment?.databases ?? []).map((database) => ({
                id: database.id,
                name: database.name,
                engine: database.engine,
                status: database.status
            }))}
        />
    );
}
