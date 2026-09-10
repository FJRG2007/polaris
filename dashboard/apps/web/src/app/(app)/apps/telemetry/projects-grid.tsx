"use client";

/**
 * The projects, as things you go into.
 *
 * They used to be a dropdown, which is the control for choosing between values
 * of a field - and a project is not a field. It has a state worth seeing before
 * you pick it: whether anything is failing in it right now, how much, and when
 * it last did. A dropdown can show none of that, so the only way to find out
 * which project needed attention was to open each one in turn.
 *
 * So it is a shelf of cards, the way every other list of things in Polaris is,
 * and the count of what is open is on the front of each one.
 */

import Link from "next/link";
import { Card, CardBody, cn } from "@polaris/ui";
import { Bug, CircleCheck } from "lucide-react";
import { RelativeTime } from "@/components/relative-time";
import type { ProjectSummary } from "@/lib/telemetry/project-service";

export interface GridProject extends ProjectSummary {
    readonly dsn: string;
}

export function ProjectsGrid({
    projects,
    hrefFor,
    action
}: {
    projects: readonly GridProject[];
    hrefFor: (projectId: string) => string;
    /** The button that makes a new one, passed in rather than built here: it
     *  owns a dialog and a reload, and neither belongs to a list. */
    action: React.ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                    {projects.length === 1 ? "One project" : `${projects.length} projects`}
                </p>
                {action}
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {projects.map((project) => (
                    <ProjectCard key={project.id} project={project} href={hrefFor(project.id)} />
                ))}
            </div>
        </div>
    );
}

function ProjectCard({ project, href }: { project: GridProject; href: string }) {
    const failing = project.openIssues > 0;
    return (
        <Link href={href} className="group block rounded-xl focus-ring">
            <Card className="h-full transition-colors group-hover:border-border-strong">
                <CardBody className="flex h-full flex-col gap-3 py-3">
                    <div className="flex items-start gap-2">
                        <span
                            className={cn(
                                "mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg",
                                failing ? "bg-danger-soft text-danger-ink" : "bg-muted text-muted-foreground"
                            )}
                        >
                            {failing ? <Bug className="size-4" /> : <CircleCheck className="size-4" />}
                        </span>
                        <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium" title={project.name}>
                                {project.name}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">
                                {/* The platform is what the first event said it
                                    was, so a project nothing has reported into
                                    yet says so rather than inventing a runtime. */}
                                {project.platform ?? "Nothing has reported yet"}
                                {project.system ? " · Polaris itself" : ""}
                            </p>
                        </div>
                        {!project.enabled && (
                            <span className="shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                                Off
                            </span>
                        )}
                    </div>

                    <div className="mt-auto flex items-baseline justify-between gap-2 text-xs">
                        <span className={cn(failing ? "font-medium text-danger" : "text-muted-foreground")}>
                            {failing
                                ? `${project.openIssues} ${project.openIssues === 1 ? "fault" : "faults"} open`
                                : "Nothing open"}
                        </span>
                        {project.lastSeen && (
                            <span className="shrink-0 text-muted-foreground">
                                <RelativeTime iso={project.lastSeen} />
                            </span>
                        )}
                    </div>
                </CardBody>
            </Card>
        </Link>
    );
}
