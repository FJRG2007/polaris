"use client";

/**
 * Deploy landing: a Railway-style grid of project cards. Each card previews its
 * default environment's services as brand-icon tiles over a dotted canvas and
 * shows an "N/M services online" status. Clicking a card opens the project.
 */

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, List, Loader2, Plus } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input } from "@polaris/ui";
import { ServiceIcon, type ServiceKind } from "./deploy-view";
import { createProjectAction } from "./actions";

export interface ProjectCardData {
    id: string;
    name: string;
    environmentName: string;
    services: ServiceKind[];
    online: number;
    total: number;
}

export function ProjectsGrid({
    projects,
    canManage,
    localReady
}: {
    projects: ProjectCardData[];
    canManage: boolean;
    localReady: boolean;
}) {
    const [layout, setLayout] = useState<"grid" | "list">("grid");
    const count = projects.length;

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex items-center justify-between gap-4">
                <h1 className="text-2xl font-semibold">Projects</h1>
                {canManage && <CreateProjectButton />}
            </div>

            {!localReady && canManage && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
                    The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>. Remote
                    servers added in the Servers view work regardless.
                </div>
            )}

            <div className="flex items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                    {count} project{count === 1 ? "" : "s"}
                </span>
                <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                    <button
                        type="button"
                        onClick={() => setLayout("grid")}
                        aria-label="Grid view"
                        className={`rounded p-1.5 transition-colors ${layout === "grid" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                        <LayoutGrid className="size-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => setLayout("list")}
                        aria-label="List view"
                        className={`rounded p-1.5 transition-colors ${layout === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                        <List className="size-4" />
                    </button>
                </div>
            </div>

            {count === 0 ? (
                <div className="rounded-xl border border-dashed border-border/60 px-6 py-20 text-center">
                    <h2 className="text-sm font-medium">Deploy your first app</h2>
                    <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                        Create a project to group environments, applications, and databases.
                    </p>
                </div>
            ) : layout === "grid" ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {projects.map((project) => (
                        <ProjectCard key={project.id} project={project} />
                    ))}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {projects.map((project) => (
                        <ProjectRow key={project.id} project={project} />
                    ))}
                </div>
            )}
        </div>
    );
}

function statusTone(online: number, total: number): { dot: string; text: string; label: string } {
    if (total === 0) return { dot: "bg-muted-foreground", text: "text-muted-foreground", label: "No services" };
    if (online >= total)
        return { dot: "bg-success", text: "text-muted-foreground", label: `${online}/${total} services online` };
    return { dot: "bg-warning", text: "text-warning", label: `${online}/${total} services online` };
}

function ServiceTiles({ services }: { services: ServiceKind[] }) {
    const shown = services.slice(0, 7);
    const overflow = services.length - shown.length;
    return (
        <div className="flex flex-wrap items-center justify-center gap-2">
            {shown.map((kind, index) => (
                <div
                    key={index}
                    className="grid size-9 place-items-center rounded-lg border border-border bg-surface text-foreground"
                >
                    <ServiceIcon kind={kind} className="size-4" />
                </div>
            ))}
            {overflow > 0 && (
                <div className="grid size-9 place-items-center rounded-lg border border-border bg-surface text-xs text-muted-foreground">
                    +{overflow}
                </div>
            )}
        </div>
    );
}

const DOT_CANVAS: React.CSSProperties = {
    backgroundImage: "radial-gradient(circle, hsl(var(--muted-foreground) / 0.15) 1px, transparent 1px)",
    backgroundSize: "16px 16px"
};

function ProjectCard({ project }: { project: ProjectCardData }) {
    const status = statusTone(project.online, project.total);
    return (
        <Link
            href={`/apps/deploy/${project.id}`}
            className="group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-muted-foreground/40"
        >
            <div className="px-4 py-3">
                <h3 className="truncate text-sm font-medium">{project.name}</h3>
            </div>
            <div className="mx-4 flex min-h-28 flex-1 items-center justify-center rounded-lg border border-border/60" style={DOT_CANVAS}>
                {project.total === 0 ? (
                    <span className="text-xs text-muted-foreground">Empty project</span>
                ) : (
                    <ServiceTiles services={project.services} />
                )}
            </div>
            <div className="flex items-center gap-2 px-4 py-3 text-xs">
                <span className={`size-1.5 rounded-full ${status.dot}`} />
                <span className="text-muted-foreground">{project.environmentName}</span>
                <span className="text-muted-foreground/50">·</span>
                <span className={status.text}>{status.label}</span>
            </div>
        </Link>
    );
}

function ProjectRow({ project }: { project: ProjectCardData }) {
    const status = statusTone(project.online, project.total);
    return (
        <Link
            href={`/apps/deploy/${project.id}`}
            className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-muted-foreground/40"
        >
            <span className="flex-1 truncate text-sm font-medium">{project.name}</span>
            <div className="flex items-center gap-1.5">
                {project.services.slice(0, 5).map((kind, index) => (
                    <ServiceIcon key={index} kind={kind} className="size-4 text-muted-foreground" />
                ))}
            </div>
            <span className="flex items-center gap-2 text-xs">
                <span className={`size-1.5 rounded-full ${status.dot}`} />
                <span className="text-muted-foreground">{project.environmentName}</span>
                <span className={status.text}>{status.label}</span>
            </span>
        </Link>
    );
}

function CreateProjectButton() {
    const router = useRouter();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!name.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createProjectAction({ name });
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            setOpen(false);
            if (result.id) router.push(`/apps/deploy/${result.id}`);
            else router.refresh();
        });
    }

    return (
        <>
            <Button onClick={() => setOpen(true)}>
                <Plus className="size-4" /> New
            </Button>
            <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent className="max-w-md">
                    <DialogHeader>
                        <DialogTitle>New project</DialogTitle>
                    </DialogHeader>
                    <div className="flex flex-col gap-3">
                        <label className="flex flex-col gap-1.5">
                            <span className="text-xs font-medium text-muted-foreground">Project name</span>
                            <Input
                                autoFocus
                                value={name}
                                onChange={(event) => setName(event.target.value)}
                                placeholder="my-project"
                                onKeyDown={(event) => event.key === "Enter" && submit()}
                            />
                        </label>
                        {error && <p className="text-sm text-danger">{error}</p>}
                        <div className="flex justify-end gap-2">
                            <Button variant="ghost" onClick={() => setOpen(false)}>
                                Cancel
                            </Button>
                            <Button onClick={submit} disabled={pending || !name.trim()}>
                                {pending && <Loader2 className="size-4 animate-spin" />} Create
                            </Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </>
    );
}
