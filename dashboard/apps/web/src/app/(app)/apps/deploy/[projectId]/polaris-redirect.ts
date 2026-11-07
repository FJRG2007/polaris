/**
 * Deploy addresses into a project Polaris runs for one of its apps.
 *
 * Those projects are not listed in Deploy any more, but links to them live on in
 * bookmarks, notifications and the audit log. Instead of "not found", each one
 * takes an administrator to the settings of the app that runs it, where its
 * services are shown. Anybody else - the member who installed a game server, say
 * - keeps the Deploy project as it always was, since those settings are an
 * administrator's screen and would otherwise leave them nowhere to reach it.
 */

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { polarisProjectRedirect } from "@/lib/deploy/managed-projects";

/** Send an administrator on when this project is one of Polaris's own; otherwise a no-op. */
export async function leaveIfPolarisProject(projectId: string, service?: unknown): Promise<void> {
    if (!(await requireUser()).isAdmin) return;
    const to = await polarisProjectRedirect(projectId, typeof service === "string" ? service : null);
    if (to) redirect(to);
}
