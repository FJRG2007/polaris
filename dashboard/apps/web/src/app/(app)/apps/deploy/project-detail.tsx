"use client";

/**
 * Project detail: the Railway-style project view. A top bar with the project name
 * and an environment switcher (production, development, ...); the active
 * environment's services render below. Creating and deleting environments and the
 * project itself are in-app, confirmation-gated actions.
 */

import { useEffect, useState, useTransition, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { List, Loader2, Plus, Trash2, Waypoints } from "lucide-react";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Input, Select } from "@polaris/ui";
import { EnvironmentServices, NewServiceButton, type ProjectApp, type ProjectSummary } from "./deploy-view";
import { DeployCanvas } from "./deploy-canvas";
import { ServiceDetail } from "./service-detail";
import { createEnvironmentAction, createProjectAction, deleteEnvironmentAction, deleteProjectAction } from "./actions";

// Sentinel option values: picking one opens a create dialog instead of switching.
const NEW_PROJECT = "__new_project__";
const NEW_ENV = "__new_environment__";

export function ProjectDetail({
    project,
    projects,
    canManage,
    localReady
}: {
    project: ProjectSummary;
    projects: { id: string; name: string }[];
    canManage: boolean;
    localReady: boolean;
}) {
    const router = useRouter();
    const refresh = () => router.refresh();

    const environments = project.environments;
    const defaultEnv = environments.find((env) => env.isDefault) ?? environments[0];
    const [activeId, setActiveId] = useState(defaultEnv?.id ?? "");
    const active = environments.find((env) => env.id === activeId) ?? defaultEnv;

    const [confirmDeleteProject, setConfirmDeleteProject] = useState(false);
    const [view, setView] = useState<"canvas" | "list">("canvas");
    const [detailApp, setDetailApp] = useState<ProjectApp | null>(null);
    const [showNewProject, setShowNewProject] = useState(false);
    const [showNewEnv, setShowNewEnv] = useState(false);
    const [pending, startTransition] = useTransition();

    const newProjectOption = canManage
        ? [{ value: NEW_PROJECT, label: "New project", icon: <Plus className="size-3.5 text-muted-foreground" /> }]
        : [];
    const newEnvOption = canManage
        ? [{ value: NEW_ENV, label: "New environment", icon: <Plus className="size-3.5 text-muted-foreground" /> }]
        : [];

    return (
        <div className="flex w-full flex-col gap-4">
            <HeaderPortal>
                <span className="text-muted-foreground/40">/</span>
                <Select
                    value={project.id}
                    onValueChange={(id) => (id === NEW_PROJECT ? setShowNewProject(true) : router.push(`/apps/deploy/${id}`))}
                    options={[...projects.map((item) => ({ value: item.id, label: item.name })), ...newProjectOption]}
                    className="h-8 w-44 min-w-[11rem] shrink-0 font-medium"
                    aria-label="Project"
                />
                <span className="text-muted-foreground/40">/</span>
                <Select
                    value={active?.id ?? ""}
                    onValueChange={(id) => (id === NEW_ENV ? setShowNewEnv(true) : setActiveId(id))}
                    options={[...environments.map((env) => ({ value: env.id, label: env.name })), ...newEnvOption]}
                    className="h-8 w-40 min-w-[10rem] shrink-0"
                    aria-label="Environment"
                />
            </HeaderPortal>

            {!localReady && canManage && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
                    The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>.
                </div>
            )}

            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
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
                <div className="flex items-center gap-2">
                    {canManage && active && <NewServiceButton environmentId={active.id} onChanged={refresh} />}
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
                    <DeployCanvas environment={active} canManage={canManage} onOpenService={setDetailApp} />
                ) : (
                    <EnvironmentServices
                        environment={active}
                        canManage={canManage}
                        onChanged={refresh}
                        onOpenService={setDetailApp}
                    />
                )
            ) : (
                <p className="text-sm text-muted-foreground">This project has no environments.</p>
            )}

            {detailApp && (
                <ServiceDetail
                    app={detailApp}
                    onChanged={refresh}
                    onClose={() => setDetailApp(null)}
                />
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
