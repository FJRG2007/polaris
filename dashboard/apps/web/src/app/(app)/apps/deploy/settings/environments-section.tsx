"use client";

/**
 * Environments: rename them, choose which one a bare link lands on, and remove
 * the ones that are finished with.
 *
 * The default environment cannot be deleted, because something has to answer
 * when a link names no environment - so the way to remove it is to promote
 * another one first. Deleting any other takes every service in it, which is why
 * it asks for the name.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SettingsCard } from "../project-settings";
import { deleteEnvironmentAction } from "../actions";
import { useDisplayFormat } from "@/components/display-format";
import { Button, ConfirmDeleteDialog, Input } from "@polaris/ui";
import { NewEnvironmentDialog } from "../new-environment-dialog";
import { Check, Pencil, Plus, Star, Trash2, X } from "lucide-react";
import { renameEnvironmentAction, setDefaultEnvironmentAction } from "../project-actions";
import type { ProjectEnvironmentView, ProjectSettingsView } from "@/lib/deploy-project-service";

export function EnvironmentsSection({
    settings,
    canManage
}: {
    settings: ProjectSettingsView;
    canManage: boolean;
}) {
    const router = useRouter();
    const [renaming, setRenaming] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [deleting, setDeleting] = useState<ProjectEnvironmentView | null>(null);
    const [creating, setCreating] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const display = useDisplayFormat();

    function startRename(environment: ProjectEnvironmentView) {
        setRenaming(environment.id);
        setDraft(environment.name);
        setError(null);
    }

    function commitRename(environment: ProjectEnvironmentView) {
        const name = draft.trim();
        if (!name || name === environment.name) {
            setRenaming(null);
            return;
        }
        startTransition(async () => {
            const result = await renameEnvironmentAction({ environmentId: environment.id, name });
            if (result.error) {
                setError(result.error);
                return;
            }
            setRenaming(null);
            router.refresh();
        });
    }

    function makeDefault(environment: ProjectEnvironmentView) {
        setError(null);
        startTransition(async () => {
            const result = await setDefaultEnvironmentAction(environment.id);
            if (result.error) setError(result.error);
            else router.refresh();
        });
    }

    function remove() {
        if (!deleting) return;
        setError(null);
        startTransition(async () => {
            const result = await deleteEnvironmentAction({
                environmentId: deleting.id,
                projectId: settings.id
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            setDeleting(null);
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Environments"
                description="Each holds its own services and its own shared variables. The default is where a link that names no environment lands."
            >
                {error && <p className="text-sm text-danger">{error}</p>}
                <div className="overflow-hidden rounded-md border border-border/60">
                    {settings.environments.map((environment) => (
                        <div
                            key={environment.id}
                            className="flex flex-wrap items-center justify-between gap-3 border-b border-border/40 px-3 py-2.5 last:border-0"
                        >
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                {renaming === environment.id ? (
                                    <>
                                        <Input
                                            autoFocus
                                            value={draft}
                                            onChange={(event) => setDraft(event.target.value)}
                                            onKeyDown={(event) => {
                                                if (event.key === "Enter") commitRename(environment);
                                                if (event.key === "Escape") setRenaming(null);
                                            }}
                                            className="h-8 max-w-56"
                                        />
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => commitRename(environment)}
                                            disabled={pending}
                                            aria-label="Save name"
                                            title="Save"
                                        >
                                            <Check className="size-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setRenaming(null)}
                                            aria-label="Cancel rename"
                                            title="Cancel"
                                        >
                                            <X className="size-4" />
                                        </Button>
                                    </>
                                ) : (
                                    <div className="min-w-0">
                                        <p className="flex items-center gap-2 truncate text-sm font-medium">
                                            {environment.name}
                                            {environment.isDefault && (
                                                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                                                    Default
                                                </span>
                                            )}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {environment.serviceCount}{" "}
                                            {environment.serviceCount === 1 ? "service" : "services"} - created{" "}
                                            {display.date(environment.createdAt)}
                                        </p>
                                    </div>
                                )}
                            </div>

                            {canManage && renaming !== environment.id && (
                                <div className="flex shrink-0 items-center gap-1">
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => startRename(environment)}
                                        aria-label={`Rename ${environment.name}`}
                                        title="Rename"
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={environment.isDefault || pending}
                                        onClick={() => makeDefault(environment)}
                                        aria-label={`Make ${environment.name} the default`}
                                        title={environment.isDefault ? "Already the default" : "Make default"}
                                    >
                                        <Star className={`size-4 ${environment.isDefault ? "fill-current" : ""}`} />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={environment.isDefault}
                                        onClick={() => setDeleting(environment)}
                                        aria-label={`Delete ${environment.name}`}
                                        title={
                                            environment.isDefault
                                                ? "Promote another environment first"
                                                : "Delete environment"
                                        }
                                    >
                                        <Trash2 className="size-4" />
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>

                {canManage && (
                    <div className="flex justify-end">
                        <Button variant="ghost" onClick={() => setCreating(true)}>
                            <Plus className="size-4" /> New environment
                        </Button>
                    </div>
                )}
            </SettingsCard>

            <NewEnvironmentDialog projectId={settings.id} open={creating} onOpenChange={setCreating} />

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="environment"
                description={
                    deleting && deleting.serviceCount > 0
                        ? `Every service in it goes too - ${deleting.serviceCount} of them, with their containers, domains and variables.`
                        : "The environment and its variables are removed."
                }
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}
