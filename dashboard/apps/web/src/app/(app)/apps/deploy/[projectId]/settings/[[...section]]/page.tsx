import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/session";
import { ProjectSettings } from "../../../project-settings";
import { SETTINGS_SECTIONS } from "../../../settings/sections";
import { getProjectSettings } from "@/lib/deploy-project-service";
import { accessCan, requireProjectAccess } from "@/lib/deploy-project-access";

export const dynamic = "force-dynamic";

/**
 * Project settings. One catch-all route rather than a file per section, so every
 * section is a real, linkable path without ten near-identical pages - the section
 * component is chosen from the slug.
 */
export default async function ProjectSettingsPage({
    params
}: {
    params: Promise<{ projectId: string; section?: string[] }>;
}) {
    const { projectId, section } = await params;
    const user = await requirePermission("deploy.read");

    let access;
    try {
        access = await requireProjectAccess(projectId, user.id, "project.read");
    } catch {
        notFound();
    }

    // An unknown slug is a mistyped link, not an error worth a page of its own.
    const slug = section?.[0] ?? "general";
    if (!SETTINGS_SECTIONS.some((entry) => entry.slug === slug)) notFound();

    const settings = await getProjectSettings(projectId);

    return (
        <ProjectSettings
            settings={settings}
            section={slug}
            canManage={accessCan(access, "project.settings")}
            isOwner={access.isOwner}
        />
    );
}
