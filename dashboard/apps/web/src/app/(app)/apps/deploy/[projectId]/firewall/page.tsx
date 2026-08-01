/**
 * A project's firewall (/apps/deploy/<project>/firewall). One scope for the project
 * and one per environment, so a rule can cover everything in it or only production.
 * The project is loaded through the owner-scoped read, so a project id that is not
 * the caller's is a 404 rather than an editable scope.
 */

import { notFound } from "next/navigation";
import { clientIp } from "@/lib/request-context";
import { requirePermission } from "@/lib/session";
import { getProjectFull } from "@/lib/deploy-service";
import { FirewallView, type FirewallScope } from "../../firewall-view";

export const dynamic = "force-dynamic";

export default async function ProjectFirewallPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    const user = await requirePermission("deploy.manage");
    const project = await getProjectFull(projectId, user.id);
    if (!project) notFound();

    const scopes: FirewallScope[] = [
        {
            type: "project",
            id: project.id,
            label: project.name,
            description: `Applies to every service in ${project.name}, in every environment. Stacks with each service's own rules.`
        },
        ...project.environments.map(
            (environment): FirewallScope => ({
                type: "environment",
                id: environment.id,
                label: environment.name,
                description: `Applies to every service in the ${environment.name} environment.`
            })
        )
    ];

    return (
        <FirewallView
            title="Firewall"
            backHref={`/apps/deploy/${project.id}`}
            backLabel={project.name}
            scopes={scopes}
            callerIp={(await clientIp()) ?? null}
        />
    );
}
