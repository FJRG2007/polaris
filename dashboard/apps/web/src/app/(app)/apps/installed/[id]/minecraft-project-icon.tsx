"use client";

/**
 * One project's own icon.
 *
 * Through Polaris rather than straight from the CDN: an `<img src>` at a third
 * party announces to them who is looking at this screen and from where, and every
 * other request this feature makes is proxied for exactly that reason. Its
 * initials for a project that never uploaded one, so a list never goes ragged.
 */
export function ProjectIcon({
    installedAppId,
    project
}: {
    installedAppId: string;
    project: { title: string; iconUrl: string | null };
}) {
    if (!project.iconUrl) {
        return (
            <div className="grid size-10 shrink-0 place-items-center rounded-md border border-border bg-surface text-xs font-medium text-muted-foreground">
                {project.title.slice(0, 2).toUpperCase()}
            </div>
        );
    }
    return (
        <img
            src={`/api/apps/installed/${installedAppId}/minecraft/modrinth/icon?url=${encodeURIComponent(project.iconUrl)}`}
            alt=""
            aria-hidden
            loading="lazy"
            className="size-10 shrink-0 rounded-md border border-border object-cover"
        />
    );
}
