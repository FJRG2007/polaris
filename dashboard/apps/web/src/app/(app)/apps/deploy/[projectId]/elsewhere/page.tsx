/**
 * What this project runs somewhere that is not Polaris.
 *
 * Its own section rather than a corner of the architecture board, because these
 * are not the same kind of thing: everything on that board is a container Polaris
 * built and can open a shell on, and one of these is a service somebody else
 * builds, serves and holds the logs for. Putting them on one canvas would offer
 * the same six buttons for both, and four of them would do nothing.
 *
 * The reading each row carries is written by the server before the page renders,
 * so the board is one query rather than one call per service to somebody else's
 * API - and anything staler than a minute is asked again on the way in.
 */

import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { ElsewhereView } from "@/app/(app)/apps/deploy/elsewhere-view";
import { getProjectFull } from "@/lib/deploy-service";
import { listConnections } from "@/lib/connections/store";
import { requireProjectAccess, accessCan } from "@/lib/deploy-project-access";
import { isProvider, listExternalServices, refreshStale } from "@/lib/deploy/external-services";

export const dynamic = "force-dynamic";

export default async function ProjectElsewherePage({
    params
}: {
    params: Promise<{ projectId: string }>;
}) {
    const { projectId } = await params;
    const user = await requirePermission("deploy.read");

    let access;
    try {
        access = await requireProjectAccess(projectId, user.id, "project.read");
    } catch {
        notFound();
    }

    const project = await getProjectFull(projectId, user.id);
    if (!project) notFound();

    // Best effort, and deliberately before the list: a provider having a bad
    // morning must not stop the page rendering, and a row that could not be read
    // says so where its state would be.
    await refreshStale(projectId).catch(() => undefined);

    const [services, links] = await Promise.all([
        listExternalServices(projectId),
        listConnections(user.id)
    ]);

    return (
        <ElsewhereView
            projectId={projectId}
            services={services}
            environments={project.environments.map((environment) => ({
                id: environment.id,
                name: environment.name
            }))}
            accounts={links
                .filter((link) => isProvider(link.provider))
                .map((link) => ({ id: link.id, provider: link.provider, label: link.label }))}
            canAdd={accessCan(access, "service.create")}
            canDeploy={accessCan(access, "deploy.run")}
            canRemove={accessCan(access, "service.delete")}
        />
    );
}
