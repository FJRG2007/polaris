"use client";

/**
 * The instance-wide webhook screen: one project at a time, chosen from a list
 * that says which ones already have endpoints - so "where do my alerts go" is
 * answered without opening ten projects to find out.
 */

import { useState } from "react";
import { cn } from "@polaris/ui";
import { ProjectWebhooks } from "@/components/project-webhooks";

export function WatchWebhooks({ projects }: { projects: { id: string; name: string; count: number }[] }) {
    // Start on a project that has something to show; otherwise the first one.
    const [selected, setSelected] = useState(
        projects.find((project) => project.count > 0)?.id ?? projects[0]?.id ?? ""
    );

    return (
        <div className="flex flex-col gap-4 md:flex-row md:gap-6">
            <nav className="md:w-52 md:shrink-0">
                <ul className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:flex-col md:overflow-visible md:px-0 md:pb-0">
                    {projects.map((project) => (
                        <li key={project.id} className="shrink-0 md:shrink">
                            <button
                                type="button"
                                onClick={() => setSelected(project.id)}
                                aria-current={selected === project.id ? "true" : undefined}
                                className={cn(
                                    "flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted",
                                    selected === project.id
                                        ? "bg-muted font-medium text-foreground"
                                        : "text-muted-foreground"
                                )}
                            >
                                <span className="truncate">{project.name}</span>
                                {project.count > 0 && (
                                    <span className="shrink-0 rounded-full border border-border/60 px-1.5 text-[0.625rem]">
                                        {project.count}
                                    </span>
                                )}
                            </button>
                        </li>
                    ))}
                </ul>
            </nav>

            <div className="min-w-0 flex-1">
                {selected && <ProjectWebhooks key={selected} projectId={selected} />}
            </div>
        </div>
    );
}
