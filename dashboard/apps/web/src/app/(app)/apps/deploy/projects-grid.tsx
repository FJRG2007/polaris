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
import {
    forwardRef,
    useEffect,
    useMemo,
    useState,
    useTransition,
    type ComponentPropsWithoutRef,
    type ReactNode
} from "react";
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
    /** Services building or provisioning right now: what the card reports instead of
     *  a count that has not moved yet, and what keeps the page looking again. */
    deploying: number;
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
    const router = useRouter();
    const [layout, setLayout] = useState<"grid" | "list">("grid");
    const [search, setSearch] = useState("");
    // Projects whose delete is in flight. Deleting one now takes its services off
    // their servers as well as its rows out of the database, which is seconds of
    // work - the card goes when the reader asks for it to go, and comes back with
    // an explanation if the server refuses.
    const [removing, setRemoving] = useState<string[]>([]);
    const [failure, setFailure] = useState<{ name: string; message: string } | null>(null);
    const [, startTransition] = useTransition();

    // The delete lives here rather than on the card, because the card is the
    // thing being removed: it unmounts the moment the delete is optimistic, and a
    // failure reported from inside it would have nowhere left to appear.
    function deleteProject(project: ProjectCardData): void {
        setFailure(null);
        setRemoving((ids) => [...ids, project.id]);
        startTransition(async () => {
            const result = await deleteProjectAction(project.id);
            if (result?.error) {
                setRemoving((ids) => ids.filter((id) => id !== project.id));
                setFailure({ name: project.name, message: result.error });
                return;
            }
            router.refresh();
        });
    }

    // Look again while any project has a build running: it finishes on the server,
    // which has no way to say so, and the card would otherwise sit on the count it
    // was rendered with until the page was reloaded.
    const settling = projects.some((project) => project.deploying > 0);
    useEffect(() => {
        if (!settling) return;
        const timer = setInterval(() => router.refresh(), 3000);
        return () => clearInterval(timer);
    }, [settling, router]);

    const visible = useMemo(
        () => projects.filter((project) => !removing.includes(project.id)),
        [projects, removing]
    );
    const fuse = useMemo(() => new Fuse(visible, { keys: ["name"], threshold: 0.4 }), [visible]);
    const filtered = search.trim() ? fuse.search(search.trim()).map((result) => result.item) : visible;
    const count = visible.length;

    return (
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <h1 className="text-[1.0625rem] font-semibold tracking-tight">Projects</h1>
                {canManage && (
                    <div className="flex flex-wrap items-center gap-2">
                        <RegistryCredentialsButton />
                        <CreateProjectButton />
                    </div>
                )}
            </div>

            {failure && (
                <div className="flex items-start justify-between gap-3 rounded-lg border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
                    <p>
                        {failure.name} was not deleted. {failure.message}
                    </p>
                    <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
                        Dismiss
                    </Button>
                </div>
            )}

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
                        <ProjectMenu
                            key={project.id}
                            project={project}
                            canManage={canManage}
                            onDelete={deleteProject}
                        >
                            <ProjectCard project={project} />
                        </ProjectMenu>
                    ))}
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    {filtered.map((project) => (
                        <ProjectMenu
                            key={project.id}
                            project={project}
                            canManage={canManage}
                            onDelete={deleteProject}
                        >
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
    onDelete,
    children
}: {
    project: ProjectCardData;
    canManage: boolean;
    /** Handed up to the grid, which owns the removal: this card is gone the
     *  moment the delete is confirmed, and cannot report how it went. */
    onDelete: (project: ProjectCardData) => void;
    children: ReactNode;
}) {
    const router = useRouter();
    const [confirming, setConfirming] = useState(false);

    const href = `/apps/deploy/${project.id}`;

    function remove() {
        setConfirming(false);
        onDelete(project);
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
                        ? `Every environment in this project goes with it, along with its ${project.total} ${project.total === 1 ? "service" : "services"} and their deploy history. Whatever they are running is stopped and removed from its server.`
                        : "The project and its environments are removed."
                }
                onConfirm={remove}
            />
        </>
    );
}

/** How a project reads on its card. A build in progress is what the project is doing,
 *  so it is what the card says: a count of what is up says nothing at all while the
 *  first service is still being made. */
function statusTone(project: ProjectCardData): { dot: string; text: string; chip: string; label: string; busy: boolean } {
    const { online, total, deploying } = project;
    const busy = deploying > 0;
    const label = busy
        ? deploying === 1
            ? "Deploying"
            : `Deploying ${deploying}`
        : total === 0
          ? "No services"
          : `${online}/${total} online`;
    if (total === 0) {
        return {
            dot: "bg-muted-foreground",
            text: "text-muted-foreground",
            chip: "border-border/60 bg-surface text-muted-foreground",
            label,
            busy
        };
    }
    if (!busy && online >= total) {
        return {
            dot: "bg-success",
            text: "text-muted-foreground",
            chip: "border-success/25 bg-success/10 text-success",
            label,
            busy
        };
    }
    return { dot: "bg-warning", text: "text-warning", chip: "border-warning/25 bg-warning/10 text-warning", label, busy };
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
        const status = statusTone(project);
        const partial = status.busy || (project.total > 0 && project.online < project.total);
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
                <h3 className="truncate text-sm font-medium" title={project.name}>
                    {project.name}
                </h3>
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
                    <span className="truncate text-xs text-muted-foreground" title={project.environmentName}>
                        {project.environmentName}
                    </span>
                    <span
                        className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs ${status.chip}`}
                    >
                        <span className={`size-1.5 rounded-full ${status.dot} ${partial ? "animate-pulse" : ""}`} />
                        {status.label}
                    </span>
                </div>
            </Link>
        );
    }
);

const ProjectRow = forwardRef<HTMLAnchorElement, { project: ProjectCardData } & ComponentPropsWithoutRef<"a">>(
    function ProjectRow({ project, className, ...rest }, ref) {
        const status = statusTone(project);
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
                <span className="flex-1 truncate text-sm font-medium" title={project.name}>
                    {project.name}
                </span>
                <div className="flex items-center gap-1.5">
                    {project.services.slice(0, 5).map((kind, index) => (
                        <ServiceIcon key={index} kind={kind} className="size-4 text-muted-foreground" />
                    ))}
                </div>
                <span className="flex items-center gap-2 text-xs">
                    <span className={`size-1.5 rounded-full ${status.dot} ${status.busy ? "animate-pulse" : ""}`} />
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
