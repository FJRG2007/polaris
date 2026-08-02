"use client";

/**
 * Deploy landing: a Railway-style grid of project cards. Each card previews its
 * default environment's services as brand-icon tiles over a dotted canvas and
 * shows an "N/M services online" status. Clicking a card opens the project.
 */

import Fuse from "fuse.js";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ServiceIcon, type ServiceKind } from "./deploy-view";
import { RegistryCredentialsButton } from "./registry-credentials";
import { createProjectAction, deleteProjectAction } from "./actions";
import { forwardRef, useMemo, useState, useTransition, type ComponentPropsWithoutRef, type ReactNode } from "react";
import {
    Copy,
    ExternalLink,
    LayoutGrid,
    List,
    Loader2,
    Plus,
    Rocket,
    Search,
    Settings,
    ShieldCheck,
    SquareArrowOutUpRight,
    Trash2
} from "lucide-react";
import {
    Button,
    ConfirmDeleteDialog,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    Input,
    cn
} from "@polaris/ui";

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
    canManageGlobal,
    localReady
}: {
    projects: ProjectCardData[];
    canManage: boolean;
    canManageGlobal: boolean;
    localReady: boolean;
}) {
    const [layout, setLayout] = useState<"grid" | "list">("grid");
    const [search, setSearch] = useState("");
    const fuse = useMemo(() => new Fuse(projects, { keys: ["name"], threshold: 0.4 }), [projects]);
    const filtered = search.trim() ? fuse.search(search.trim()).map((result) => result.item) : projects;
    const count = projects.length;

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h1 className="text-2xl font-semibold">Projects</h1>
                {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                        {canManageGlobal && (
                            <Link
                                href="/apps/deploy/firewall"
                                aria-label="Firewall"
                                title="Firewall"
                                className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                            >
                                <ShieldCheck className="size-4" />
                            </Link>
                        )}
                        <RegistryCredentialsButton />
                        <CreateProjectButton />
                    </div>
                )}
            </div>

            {!localReady && canManage && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
                    The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>. Remote
                    servers added in the Servers view work regardless.
                </div>
            )}

            <div className="flex items-center justify-between gap-2">
                <div className="relative max-w-xs flex-1">
                    <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder={`Search ${count} project${count === 1 ? "" : "s"}`}
                        className="h-8 pl-8"
                    />
                </div>
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
                <div
                    className="relative flex flex-col items-center gap-3 overflow-hidden rounded-xl border border-border/60 px-6 py-24 text-center"
                    style={DOT_CANVAS}
                >
                    <div
                        className="pointer-events-none absolute inset-0"
                        style={{ background: "radial-gradient(120% 90% at 50% 40%, transparent 45%, hsl(var(--background)) 100%)" }}
                    />
                    <span className="relative grid size-12 place-items-center rounded-xl border border-border bg-card text-primary">
                        <Rocket className="size-5" />
                    </span>
                    <div className="relative">
                        <h2 className="text-sm font-medium">Deploy your first app</h2>
                        <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
                            Create a project to group environments, applications, and databases.
                        </p>
                    </div>
                </div>
            ) : filtered.length === 0 ? (
                <p className="py-16 text-center text-sm text-muted-foreground">No projects match &ldquo;{search}&rdquo;.</p>
            ) : layout === "grid" ? (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {filtered.map((project) => (
                        <ProjectMenu key={project.id} project={project} canManage={canManage}>
                            <ProjectCard project={project} />
                        </ProjectMenu>
                    ))}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((project) => (
                        <ProjectMenu key={project.id} project={project} canManage={canManage}>
                            <ProjectRow project={project} />
                        </ProjectMenu>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * Right-click on a project. The menu opens what the card already opens, plus the
 * things that would otherwise mean going into the project first - its settings,
 * its id, and deleting it.
 *
 * Delete is the reason this exists in the shape it does: it is the one entry that
 * cannot be undone, so it sits below a separator, reads in the danger tone, and
 * leads to a dialog that will not proceed until the project's name is typed out.
 */
function ProjectMenu({
    project,
    canManage,
    children
}: {
    project: ProjectCardData;
    canManage: boolean;
    children: ReactNode;
}) {
    const router = useRouter();
    const [confirming, setConfirming] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const href = `/apps/deploy/${project.id}`;

    function remove() {
        setError(null);
        startTransition(async () => {
            const result = await deleteProjectAction(project.id);
            if (result?.error) {
                setError(result.error);
                return;
            }
            setConfirming(false);
            router.refresh();
        });
    }

    return (
        <>
            <ContextMenu>
                <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
                <ContextMenuContent>
                    <ContextMenuLabel>{project.name}</ContextMenuLabel>
                    <ContextMenuItem onSelect={() => router.push(href)}>
                        <ExternalLink className="size-4" /> Open
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => window.open(href, "_blank", "noopener,noreferrer")}>
                        <SquareArrowOutUpRight className="size-4" /> Open in new tab
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => router.push(`${href}/settings`)}>
                        <Settings className="size-4" /> Settings
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => void navigator.clipboard?.writeText(project.id)}>
                        <Copy className="size-4" /> Copy project ID
                    </ContextMenuItem>
                    {canManage && (
                        <>
                            <ContextMenuSeparator />
                            <ContextMenuItem variant="danger" onSelect={() => setConfirming(true)}>
                                <Trash2 className="size-4" /> Delete
                            </ContextMenuItem>
                        </>
                    )}
                </ContextMenuContent>
            </ContextMenu>

            <ConfirmDeleteDialog
                open={confirming}
                onOpenChange={setConfirming}
                name={project.name}
                kind="project"
                description={
                    project.total > 0
                        ? `Every environment in this project goes with it, along with its ${project.total} ${project.total === 1 ? "service" : "services"} and their deploy history.`
                        : "The project and its environments are removed."
                }
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </>
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

/**
 * The card, and the row below it, are wrapped by the context-menu trigger, which
 * clones them and hands down its own listeners and ref. That only reaches the DOM
 * if the component passes them on - so both forward their ref and spread whatever
 * they were given onto the anchor. Without this the card renders perfectly and
 * right-clicking it does nothing at all.
 */
const ProjectCard = forwardRef<HTMLAnchorElement, { project: ProjectCardData } & ComponentPropsWithoutRef<"a">>(
    function ProjectCard({ project, className, ...rest }, ref) {
        const status = statusTone(project.online, project.total);
        const partial = project.total > 0 && project.online < project.total;
        const chip =
            project.total === 0
                ? "border-border/60 bg-surface text-muted-foreground"
                : partial
                  ? "border-warning/25 bg-warning/10 text-warning"
                  : "border-success/25 bg-success/10 text-success";
        return (
            <Link
                ref={ref}
                href={`/apps/deploy/${project.id}`}
                className={cn(
                    "group flex flex-col overflow-hidden rounded-xl border border-border bg-card transition-colors hover:border-muted-foreground/40 hover:bg-card-hover",
                    className
                )}
                {...rest}
            >
            <div className="flex items-center justify-between gap-2 px-4 py-3">
                <h3 className="truncate text-sm font-medium">{project.name}</h3>
                <span className="shrink-0 text-xs text-muted-foreground">
                    {project.total} {project.total === 1 ? "service" : "services"}
                </span>
            </div>
            <div className="mx-4 flex min-h-44 flex-1 items-center justify-center rounded-lg border border-border/60" style={DOT_CANVAS}>
                {project.total === 0 ? (
                    <span className="text-xs text-muted-foreground">Empty project</span>
                ) : (
                    <ServiceTiles services={project.services} />
                )}
            </div>
                <div className="flex items-center justify-between gap-2 px-4 py-3">
                    <span className="truncate text-xs text-muted-foreground">{project.environmentName}</span>
                    <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${chip}`}
                    >
                        <span className={`size-1.5 rounded-full ${status.dot} ${partial ? "animate-pulse" : ""}`} />
                        {project.total === 0 ? "No services" : `${project.online}/${project.total} online`}
                    </span>
                </div>
            </Link>
        );
    }
);

const ProjectRow = forwardRef<HTMLAnchorElement, { project: ProjectCardData } & ComponentPropsWithoutRef<"a">>(
    function ProjectRow({ project, className, ...rest }, ref) {
        const status = statusTone(project.online, project.total);
        return (
            <Link
                ref={ref}
                href={`/apps/deploy/${project.id}`}
                className={cn(
                    "flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:border-muted-foreground/40",
                    className
                )}
                {...rest}
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
);

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
