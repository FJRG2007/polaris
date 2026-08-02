import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { ProjectShell } from "../project-shell";
import { listProjects, getProject } from "@/lib/deploy-service";
import { requirePermission, userHasManage } from "@/lib/session";
import { listProjectStagedChanges } from "@/lib/deploy-staged-changes";

export const dynamic = "force-dynamic";

/**
 * Chrome shared by every screen inside one project: the project and environment
 * switchers in the header, the section rail (Architecture, Observability, Logs,
 * Settings), and the changeset banner.
 *
 * It lives in a layout rather than in each page so switching section keeps the
 * environment you were on and never re-renders the rail - and so the pending
 * changes are counted once for the project instead of once per screen.
 */
export default async function ProjectLayout({
    children,
    params
}: {
    children: ReactNode;
    params: Promise<{ projectId: string }>;
}) {
    const { projectId } = await params;
    const user = await requirePermission("deploy.read");
    const canManage = await userHasManage(user, "deploy.manage");

    const project = await getProject(projectId, user.id);
    if (!project) notFound();

    const [projects, staged] = await Promise.all([
        listProjects(user.id),
        listProjectStagedChanges(projectId)
    ]);

    return (
        <ProjectShell
            project={{
                id: project.id,
                name: project.name,
                environments: project.environments.map((environment) => ({
                    id: environment.id,
                    name: environment.name,
                    isDefault: environment.isDefault
                }))
            }}
            projects={projects.map((item) => ({ id: item.id, name: item.name }))}
            staged={staged}
            canManage={canManage}
        >
            {children}
        </ProjectShell>
    );
}
