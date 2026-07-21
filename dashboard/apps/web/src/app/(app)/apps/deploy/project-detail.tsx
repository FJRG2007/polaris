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
import { createEnvironmentAction, deleteEnvironmentAction, deleteProjectAction } from "./actions";

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
    const [pending, startTransition] = useTransition();

    return (
        <div className="flex w-full flex-col gap-4">
            <HeaderPortal>
                <span className="text-muted-foreground/40">/</span>
                <Select
                    value={project.id}
                    onValueChange={(id) => router.push(`/apps/deploy/${id}`)}
                    options={projects.map((item) => ({ value: item.id, label: item.name }))}
                    className="h-8 w-40 font-medium"
                    aria-label="Project"
                />
                <span className="text-muted-foreground/40">/</span>
                <Select
                    value={active?.id ?? ""}
                    onValueChange={setActiveId}
                    options={environments.map((env) => ({ value: env.id, label: env.name }))}
                    className="h-8 w-36"
                    aria-label="Environment"
                />
                {canManage && <NewEnvironmentButton projectId={project.id} onChanged={refresh} />}
            </HeaderPortal>

            {!localReady && canManage && (
                <div className="rounded-lg border border-warning/30 bg-warning/5 px-4 py-3 text-sm text-muted-foreground">
                    The local host is not ready to build and deploy. This needs the full edition with a running{" "}
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-foreground">polaris-hostd</code>.
                </div>
            )}

            <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
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
        </div>
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

function NewEnvironmentButton({ projectId, onChanged }: { projectId: string; onChanged: () => void }) {
    const [open, setOpen] = useState(false);
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
            setOpen(false);
            onChanged();
        });
    }

    return (
        <>
            <button
                type="button"
                onClick={() => setOpen(true)}
                title="New environment"
                className="ml-1 rounded p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
                <Plus className="size-4" />
            </button>
            <Dialog open={open} onOpenChange={setOpen}>
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
