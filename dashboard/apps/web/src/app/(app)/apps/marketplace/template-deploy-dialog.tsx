"use client";

/**
 * Deploying a template from the marketplace: pick the project and environment it
 * goes into, then Deploy's own template form - the one behind "New service >
 * From a template" - takes over, opened on this template. There is one way a
 * template becomes a service, and this only finds it a project first.
 */

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Field } from "../deploy/form-field";
import { createProjectAction } from "../deploy/actions";
import { NewTemplateForm } from "../deploy/service-form";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PagedPicker } from "@/components/paged-picker";
import * as options from "@/app/(app)/deploy-target-options-actions";
import type { TemplateProjectOption } from "@/lib/deploy-target-options-schema";
import {
    Button,
    Input,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    dropAsyncOptions
} from "@polaris/ui";

/** The picker's own entry that opens the new-project form instead of choosing one. */
const NEW_PROJECT = "__new-project__";
const PROJECTS_CACHE = "template-projects";

export function TemplateDeployDialog({
    templateId,
    name,
    onClose
}: {
    /** The Deploy template's own id. */
    templateId: string;
    name: string;
    onClose: () => void;
}) {
    const t = useTranslations("marketplace");
    const router = useRouter();
    // The first project and its default environment are chosen up front; the
    // pickers page the rest from the server as somebody searches or scrolls.
    const [project, setProject] = useState<TemplateProjectOption | null | undefined>(undefined);
    const [failed, setFailed] = useState(false);
    const [environmentId, setEnvironmentId] = useState("");
    const [chosen, setChosen] = useState(false);
    const [creating, setCreating] = useState(false);

    useEffect(() => {
        void options
            .templateProjectOptionsAction({ limit: 1 })
            .then((page) => {
                if ("error" in page) return setFailed(true);
                const first = page.items[0] ?? null;
                setProject(first);
                setEnvironmentId(first?.environmentId ?? "");
            })
            .catch(() => setFailed(true));
    }, []);

    const projectId = project?.id ?? "";

    function pickProject(next: TemplateProjectOption | null) {
        if (!next) return;
        setProject(next);
        setEnvironmentId(next.environmentId ?? "");
    }

    function created(next: TemplateProjectOption) {
        // The picker's cached pages predate the project; the next open reads them again.
        dropAsyncOptions(PROJECTS_CACHE);
        setCreating(false);
        pickProject(next);
    }

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader>
                    <DialogTitle>{t("templateDeploy.title", { name })}</DialogTitle>
                    <DialogDescription>{t("templateDeploy.description")}</DialogDescription>
                </DialogHeader>
                {chosen && environmentId ? (
                    <NewTemplateForm
                        environmentId={environmentId}
                        initialTemplateId={templateId}
                        onDone={() => {
                            onClose();
                            router.push(`/apps/deploy/${projectId}`);
                        }}
                    />
                ) : failed ? (
                    <p role="alert" className="text-sm text-danger">
                        {t("templateDeploy.failed")}
                    </p>
                ) : project === undefined ? (
                    <div className="flex justify-center py-6" aria-busy>
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                ) : project === null || creating ? (
                    <div className="flex flex-col gap-3">
                        {project === null ? (
                            <p className="text-sm text-muted-foreground">
                                {t("templateDeploy.noProjects")}
                            </p>
                        ) : null}
                        <NewProjectForm
                            onCreated={created}
                            onCancel={project === null ? undefined : () => setCreating(false)}
                        />
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <Field label={t("templateDeploy.project")}>
                            <PagedPicker<TemplateProjectOption>
                                read={options.templateProjectOptionsAction}
                                scope={{}}
                                cache={PROJECTS_CACHE}
                                className="w-full"
                                value={projectId}
                                selectedLabel={project.name}
                                fixed={[
                                    { value: NEW_PROJECT, label: t("templateDeploy.createProject") }
                                ]}
                                onValueChange={(id, item) =>
                                    id === NEW_PROJECT ? setCreating(true) : pickProject(item)
                                }
                                aria-label={t("templateDeploy.project")}
                                placeholder={t("templateDeploy.project")}
                                searchPlaceholder={t("templateDeploy.projectSearch")}
                                emptyText={t("templateDeploy.projectNone")}
                            />
                        </Field>
                        {project.manyEnvironments ? (
                            <Field label={t("templateDeploy.environment")}>
                                <PagedPicker
                                    read={options.templateEnvironmentOptionsAction}
                                    scope={{ projectId }}
                                    cache="template-environments"
                                    className="w-full"
                                    value={environmentId}
                                    onValueChange={(id) => setEnvironmentId(id)}
                                    aria-label={t("templateDeploy.environment")}
                                    placeholder={t("templateDeploy.environment")}
                                    searchPlaceholder={t("templateDeploy.environmentSearch")}
                                    emptyText={t("templateDeploy.environmentNone")}
                                />
                            </Field>
                        ) : null}
                        <div className="flex justify-end">
                            <Button
                                size="sm"
                                disabled={!environmentId}
                                onClick={() => setChosen(true)}
                            >
                                {t("templateDeploy.next")}
                            </Button>
                        </div>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}

/**
 * A project made without leaving the dialog, through the same action and the
 * same name rule as Deploy's own "New project", then handed back chosen.
 */
function NewProjectForm({
    onCreated,
    onCancel
}: {
    onCreated: (project: TemplateProjectOption) => void;
    /** Absent when there is no other project to go back to. */
    onCancel?: () => void;
}) {
    const t = useTranslations("marketplace");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function submit() {
        if (!name.trim() || pending) return;
        setError(null);
        startTransition(async () => {
            const result = await createProjectAction({ name });
            if (result.error || !result.id) {
                setError(result.error ?? t("templateDeploy.createFailed"));
                return;
            }
            // Read back as the picker lists it, default environment included.
            const page = await options
                .templateProjectOptionsAction({ ids: [result.id] })
                .catch(() => null);
            const option = page && !("error" in page) ? page.items[0] : undefined;
            if (!option) {
                setError(t("templateDeploy.createFailed"));
                return;
            }
            onCreated(option);
        });
    }

    return (
        <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
                event.preventDefault();
                submit();
            }}
        >
            <Field label={t("templateDeploy.projectName")}>
                <Input
                    autoFocus
                    value={name}
                    disabled={pending}
                    onChange={(event) => setName(event.target.value)}
                    aria-invalid={error ? true : undefined}
                    // i18n-ignore: an example project name
                    placeholder="my-project"
                />
            </Field>
            {error ? (
                <p role="alert" className="text-sm text-danger">
                    {error}
                </p>
            ) : null}
            <div className="flex justify-end gap-2">
                {onCancel ? (
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={onCancel}
                        disabled={pending}
                    >
                        {t("templateDeploy.cancel")}
                    </Button>
                ) : null}
                <Button type="submit" size="sm" disabled={pending || !name.trim()}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("templateDeploy.create")}
                </Button>
            </div>
        </form>
    );
}
