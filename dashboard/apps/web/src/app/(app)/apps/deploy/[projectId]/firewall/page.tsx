/**
 * A project's firewall, reached from the project's own toolbar.
 *
 * The rules themselves live on the firewall page now, which can address any scope
 * through the URL - so this is a redirect rather than a second copy of the editor.
 * Two firewall screens that drift apart is exactly the fragmentation the scope picker
 * was built to remove.
 *
 * The project is still resolved through the owner-scoped read first, so a project id
 * that is not the caller's is a 404 here rather than a redirect that leaks whether it
 * exists.
 */

import { requirePermission } from "@/lib/session";
import { getProject } from "@/lib/deploy-service";
import { notFound, redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function ProjectFirewallPage({ params }: { params: Promise<{ projectId: string }> }) {
    const { projectId } = await params;
    const user = await requirePermission("deploy.manage");
    const project = await getProject(projectId, user.id);
    if (!project) notFound();
    redirect(`/apps/firewall?scope=project&id=${project.id}`);
}
