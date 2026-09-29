"use client";

/**
 * Environments: rename them, choose which one a bare link lands on, choose which
 * of their services can reach each other, and remove the ones that are finished
 * with.
 *
 * The default environment cannot be deleted, because something has to answer
 * when a link names no environment - so the way to remove it is to promote
 * another one first. Deleting any other takes every service in it, which is why
 * it asks for the name.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SettingsCard } from "../project-settings";
import { NetworkingCard } from "./networking-card";
import { deleteEnvironmentAction } from "../actions";
import { useDisplayFormat } from "@/components/display-format";
import { useTranslations } from "@/components/i18n/i18n-provider";
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
    const t = useTranslations("deploySettings");
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
                title={t("environments.title")}
                description={t("environments.description")}
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
                                            aria-label={t("environments.saveName")}
                                            title={t("environments.save")}
                                        >
                                            <Check className="size-4" />
                                        </Button>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            onClick={() => setRenaming(null)}
                                            aria-label={t("environments.cancelRename")}
                                            title={t("environments.cancel")}
                                        >
                                            <X className="size-4" />
                                        </Button>
                                    </>
                                ) : (
                                    <div className="min-w-0">
                                        <p className="flex items-center gap-2 truncate text-sm font-medium">
                                            {environment.name}
                                            {environment.isDefault && (
                                                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[0.625rem] font-medium text-primary">
                                                    {t("environments.default")}
                                                </span>
                                            )}
                                            {environment.pullRequest !== null && environment.previewRepo && (
                                                <a
                                                    href={`https://github.com/${environment.previewRepo}/pull/${environment.pullRequest}`}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    title={t("environments.openPullRequest")}
                                                    className="rounded-full border border-border px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground hover:text-foreground"
                                                >
                                                    {t("environments.previewOf", { number: environment.pullRequest })}
                                                </a>
                                            )}
                                        </p>
                                        <p className="truncate text-xs text-muted-foreground">
                                            {t("environments.services", { count: environment.serviceCount })}
                                            {environment.branch
                                                ? t.rich("environments.follows", {
                                                      branch: environment.branch,
                                                      mono: (chunks) => (
                                                          <span key="branch" className="font-mono">
                                                              {chunks}
                                                          </span>
                                                      )
                                                  })
                                                : null}
                                            {t("environments.created", { date: display.date(environment.createdAt) })}
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
                                        aria-label={t("environments.renameNamed", { name: environment.name })}
                                        title={t("environments.rename")}
                                    >
                                        <Pencil className="size-4" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={environment.isDefault || pending}
                                        onClick={() => makeDefault(environment)}
                                        aria-label={t("environments.makeDefaultNamed", { name: environment.name })}
                                        title={environment.isDefault ? t("environments.alreadyDefault") : t("environments.makeDefault")}
                                    >
                                        <Star className={`size-4 ${environment.isDefault ? "fill-current" : ""}`} />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="icon"
                                        disabled={environment.isDefault}
                                        onClick={() => setDeleting(environment)}
                                        aria-label={t("environments.deleteNamed", { name: environment.name })}
                                        title={
                                            environment.isDefault
                                                ? t("environments.promoteFirst")
                                                : t("environments.delete")
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
                            <Plus className="size-4" /> {t("environments.new")}
                        </Button>
                    </div>
                )}
            </SettingsCard>

            <NetworkingCard settings={settings} canManage={canManage} />

            <NewEnvironmentDialog
                projectId={settings.id}
                open={creating}
                onOpenChange={setCreating}
                environments={settings.environments}
            />

            <ConfirmDeleteDialog
                open={deleting !== null}
                onOpenChange={(open) => !open && setDeleting(null)}
                name={deleting?.name ?? ""}
                kind="environment"
                title={t("environments.deleteTitle")}
                confirmLabel={t("environments.deleteTitle")}
                description={
                    deleting && deleting.serviceCount > 0
                        ? t("environments.deleteWithServices", { count: deleting.serviceCount })
                        : t("environments.deleteEmpty")
                }
                error={error}
                pending={pending}
                onConfirm={remove}
            />
        </div>
    );
}
