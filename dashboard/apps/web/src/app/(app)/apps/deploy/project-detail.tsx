"use client";

/**
 * Project detail: the Railway-style project view. A top bar with the project name
 * and an environment switcher (production, development, ...); the active
 * environment's services render below. Creating and deleting environments and the
 * project itself are in-app, confirmation-gated actions.
 */

import Link from "next/link";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { DeployCanvas } from "./deploy-canvas";
import { ServiceDetail } from "./service-detail";
import { useEffect, useState, useTransition, type ReactNode } from "react";
import { List, Loader2, Plus, ShieldCheck, Trash2, Waypoints } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";
import { EnvironmentServices, NewServiceButton, type ProjectApp, type ProjectSummary } from "./deploy-view";
import { createEnvironmentAction, createProjectAction, deleteEnvironmentAction, deleteProjectAction } from "./actions";

// Sentinel option values: picking one opens a create dialog instead of switching.
const NEW_PROJECT = "__new_project__";
const NEW_ENV = "__new_environment__";

export function ProjectDetail({
    project,
    projects,
    canManage,
    localReady,
    openService,
    openEnvironment
}: {
    project: ProjectSummary;
    projects: { id: string; name: string }[];
    canManage: boolean;
    localReady: boolean;
    /** Service to open on arrival, from the URL - a deploy alert or a shared link. */
    openService?: string | null;
    /** Environment to select on arrival, for a link that names no service. */
    openEnvironment?: string | null;
}) {
    const router = useRouter();
    const refresh = () => router.refresh();

    const environments = project.environments;
    const defaultEnv = environments.find((env) => env.isDefault) ?? environments[0];
    // A link that names a service lands on the environment holding it, not on
    // whichever one the project happens to open with.
    const linked = openService
        ? environments.find((env) => env.applications.some((app) => app.id === openService))
        : environments.find((env) => env.id === openEnvironment);
    const [activeId, setActiveId] = useState(linked?.id ?? defaultEnv?.id ?? "");
    const active = environments.find((env) => env.id === activeId) ?? defaultEnv;

    const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
    const [view, setView] = useState<"canvas" | "list">("canvas");
    const [detailAppId, setDetailAppId] = useState<string | null>(openService ?? null);
    const [showNewProject, setShowNewProject] = useState(false);
    const [showNewEnv, setShowNewEnv] = useState(false);
    const [pending, startTransition] = useTransition();

    // Derived rather than stored, so refreshed data reaches the open panel (e.g.
    // after removing a domain) and a deleted service closes it instead of leaving
    // a stale snapshot on screen.
    const detailApp = environments.flatMap((env) => env.applications).find((app) => app.id === detailAppId) ?? null;

    /** Open or close the service panel, keeping the URL on the service so the page
     *  can be linked to, reloaded and shared where it was left. Written straight to
     *  history rather than navigated, since the panel is already rendered. */
    function showService(app: ProjectApp | null) {
        setDetailAppId(app?.id ?? null);
        const url = new URL(window.location.href);
        if (app) url.searchParams.set("service", app.id);
        else url.searchParams.delete("service");
        url.searchParams.delete("env");
        window.history.replaceState(null, "", url);
    }

    /** Switching environment by hand leaves the link that opened this page behind:
     *  the panel belonged to the environment being left, and a reload must not
     *  drag the page back to it. */
    function selectEnvironment(id: string) {
        setActiveId(id);
        setDetailAppId(null);
        const url = new URL(window.location.href);
        url.searchParams.delete("service");
        url.searchParams.delete("env");
        window.history.replaceState(null, "", url);
    }

    const newProjectOption = canManage
        ? [{ value: NEW_PROJECT, label: "New project", icon: <Plus className="size-3.5 text-muted-foreground" /> }]
        : [];
    const newEnvOption = canManage
        ? [{ value: NEW_ENV, label: "New environment", icon: <Plus className="size-3.5 text-muted-foreground" /> }]
        : [];

    const projectSelect = (
        <Select
            value={project.id}
            onValueChange={(id) => (id === NEW_PROJECT ? setShowNewProject(true) : router.push(`/apps/deploy/${id}`))}
            options={[...projects.map((item) => ({ value: item.id, label: item.name })), ...newProjectOption]}
            className="h-8 min-w-0 flex-1 font-medium md:w-44 md:min-w-[11rem] md:flex-none"
            aria-label="Project"
        />
    );
    const environmentSelect = (
        <Select
            value={active?.id ?? ""}
            onValueChange={(id) => (id === NEW_ENV ? setShowNewEnv(true) : selectEnvironment(id))}
            options={[...environments.map((env) => ({ value: env.id, label: env.name })), ...newEnvOption]}
            className="h-8 min-w-0 flex-1 md:w-52 md:min-w-[13rem] md:flex-none"
            aria-label="Environment"
        />
    );

    return (
        <div className="flex w-full flex-col gap-4">
            {/* The two switchers sit in the top bar where there is room for them
                beside the app switcher, and at the top of the page where there is
                not - the same controls, never both visible at once. */}
            <HeaderPortal>
                <span className="hidden text-muted-foreground/40 md:inline">/</span>
                <span className="hidden items-center gap-2 md:flex">
                    {projectSelect}
                    <span className="text-muted-foreground/40">/</span>
                    {environmentSelect}
                </span>
            </HeaderPortal>

            <div className="flex items-center gap-2 md:hidden">
                {projectSelect}
                {environmentSelect}
            </div>

            {!localReady && canManage && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
                    The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>.
                </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                    {active && <EnvSummary environment={active} />}
                    {canManage && active && !active.isDefault && (
                        <DeleteEnvironmentButton
                            environmentId={active.id}
                            projectId={project.id}
                            onDeleted={() => {
                                setActiveId(defaultEnv?.id ?? "");
                                refresh();
                            }}
                        />
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    {canManage && active && <NewServiceButton environmentId={active.id} onChanged={refresh} />}
                    {canManage && (
                        <Link
                            href={`/apps/deploy/${project.id}/firewall`}
                            aria-label="Firewall"
                            title="Firewall"
                            className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                            <ShieldCheck className="size-4" />
                        </Link>
                    )}
                    <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
                        <button
                            type="button"
                            onClick={() => setView("canvas")}
                            aria-label="Canvas view"
                            className={`rounded p-1.5 transition-colors ${view === "canvas" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        >
                            <Waypoints className="size-4" />
                        </button>
                        <button
                            type="button"
                            onClick={() => setView("list")}
                            aria-label="List view"
                            className={`rounded p-1.5 transition-colors ${view === "list" ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                        >
                            <List className="size-4" />
                        </button>
                    </div>
                    {canManage &&
                        (confirmDeleteProject ? (
                            <div className="flex items-center gap-2">
                                <span className="text-xs text-muted-foreground">Delete project?</span>
                                <Button
                                    variant="danger"
                                    size="sm"
                                    disabled={pending}
                                    onClick={() =>
                                        startTransition(async () => {
                                            await deleteProjectAction(project.id);
                                            router.push("/apps/deploy");
                                        })
                                    }
                                >
                                    {pending && <Loader2 className="size-4 animate-spin" />} Confirm
                                </Button>
                                <Button variant="ghost" size="sm" onClick={() => setConfirmDeleteProject(false)}>
                                    Cancel
                                </Button>
                            </div>
                        ) : (
                            <Button variant="ghost" size="icon" title="Delete project" onClick={() => setConfirmDeleteProject(true)}>
                                <Trash2 className="size-4" />
                            </Button>
                        ))}
                </div>
            </div>

            {active ? (
                view === "canvas" ? (
                    <DeployCanvas environment={active} canManage={canManage} onOpenService={showService} />
                ) : (
                    <EnvironmentServices
                        environment={active}
                        canManage={canManage}
                        onChanged={refresh}
                        onOpenService={showService}
                    />
                )
            ) : (
                <p className="text-sm text-muted-foreground">This project has no environments.</p>
            )}

            {detailApp && (
                <ServiceDetail app={detailApp} onChanged={refresh} onClose={() => showService(null)} />
            )}

            <NewProjectDialog open={showNewProject} onOpenChange={setShowNewProject} />
            <NewEnvironmentDialog
                projectId={project.id}
                open={showNewEnv}
                onOpenChange={setShowNewEnv}
                onChanged={refresh}
            />
        </div>
    );
}

/** A tinted chip summarizing how many of the environment's services are online. */
function EnvSummary({ environment }: { environment: ProjectSummary["environments"][number] }) {
    const online =
        environment.applications.filter((app) => app.currentDeploymentId).length +
        environment.databases.filter((db) => ["running", "active", "healthy", "ready"].includes(db.status.toLowerCase())).length;
    const total = environment.applications.length + environment.databases.length;
    const partial = total > 0 && online < total;
    const chip =
        total === 0
            ? "border-border/60 bg-surface text-muted-foreground"
            : partial
              ? "border-warning/25 bg-warning/10 text-warning"
              : "border-success/25 bg-success/10 text-success";
    const dot = total === 0 ? "bg-muted-foreground" : partial ? "bg-warning" : "bg-success";
    return (
        <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${chip}`}>
            <span className={`size-1.5 rounded-full ${dot} ${partial ? "animate-pulse" : ""}`} />
            {total === 0 ? "No services" : `${online}/${total} online`}
        </span>
    );
}

/** Render children into the app-shell header slot (right of the app switcher). */
function HeaderPortal({ children }: { children: ReactNode }) {
    const [target, setTarget] = useState<HTMLElement | null>(null);
    useEffect(() => {
        setTarget(document.getElementById("polaris-header-slot"));
    }, []);
    return target ? createPortal(children, target) : null;
}

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
    const router = useRouter();
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
            onOpenChange(false);
            if (result.id) router.push(`/apps/deploy/${result.id}`);
            else router.refresh();
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
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
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim()}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function NewEnvironmentDialog({
    projectId,
    open,
    onOpenChange,
    onChanged
}: {
    projectId: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onChanged: () => void;
}) {
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!name.trim()) return;
        setError(null);
        startTransition(async () => {
            const result = await createEnvironmentAction({ projectId, name });
            if (result.error) {
                setError(result.error);
                return;
            }
            setName("");
            onOpenChange(false);
            onChanged();
        });
    }

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>New environment</DialogTitle>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Name</span>
                        <Input
                            autoFocus
                            value={name}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="development"
                            onKeyDown={(event) => event.key === "Enter" && submit()}
                        />
                    </label>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={() => onOpenChange(false)}>
                            Cancel
                        </Button>
                        <Button onClick={submit} disabled={pending || !name.trim()}>
                            {pending && <Loader2 className="size-4 animate-spin" />} Create
                        </Button>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}

function DeleteEnvironmentButton({
    environmentId,
    projectId,
    onDeleted
}: {
    environmentId: string;
    projectId: string;
    onDeleted: () => void;
}) {
    const [confirm, setConfirm] = useState(false);
    const [pending, startTransition] = useTransition();

    if (!confirm) {
        return (
            <button
                type="button"
                onClick={() => setConfirm(true)}
                title="Delete environment"
                className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-danger"
            >
                <Trash2 className="size-4" />
            </button>
        );
    }

    return (
        <span className="flex items-center gap-1 pl-1 text-xs text-muted-foreground">
            Delete?
            <Button
                variant="danger"
                size="sm"
                disabled={pending}
                onClick={() =>
                    startTransition(async () => {
                        await deleteEnvironmentAction({ environmentId, projectId });
                        setConfirm(false);
                        onDeleted();
                    })
                }
            >
                {pending && <Loader2 className="size-4 animate-spin" />} Yes
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirm(false)}>
                No
            </Button>
        </span>
    );
}
