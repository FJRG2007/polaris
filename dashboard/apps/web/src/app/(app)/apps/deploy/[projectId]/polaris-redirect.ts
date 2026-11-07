/**
 * Deploy addresses into a project Polaris runs for one of its apps.
 *
 * Those projects are not listed in Deploy any more, but links to them live on in
 * bookmarks, notifications and the audit log. Instead of "not found", each one
 * goes to the settings of the app that runs it, where its services are shown;
 * that page asks for an administrator itself.
 */

import { redirect } from "next/navigation";
import { polarisProjectRedirect } from "@/lib/deploy/managed-projects";

/** Send the reader on when this project is one of Polaris's own; otherwise a no-op. */
export async function leaveIfPolarisProject(projectId: string, service?: unknown): Promise<void> {
    const to = await polarisProjectRedirect(projectId, typeof service === "string" ? service : null);
    if (to) redirect(to);
}
