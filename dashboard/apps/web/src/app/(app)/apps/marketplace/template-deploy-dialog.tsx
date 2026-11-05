"use client";

/**
 * Deploying a template from the marketplace: pick the project and environment it
 * goes into, then Deploy's own template form - the one behind "New service >
 * From a template" - takes over, opened on this template. There is one way a
 * template becomes a service, and this only finds it a project first.
 */

import Link from "next/link";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Field } from "../deploy/form-field";
import { NewTemplateForm } from "../deploy/service-form";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { PagedPicker } from "@/components/paged-picker";
import * as options from "@/app/(app)/deploy-target-options-actions";
import type { TemplateProjectOption } from "@/lib/deploy-target-options-schema";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle
} from "@polaris/ui";

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
                ) : project === null ? (
                    <div className="flex flex-col items-start gap-3">
                        <p className="text-sm text-muted-foreground">
                            {t("templateDeploy.noProjects")}
                        </p>
                        <Button asChild size="sm">
                            <Link href="/apps/deploy">{t("templateDeploy.newProject")}</Link>
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <Field label={t("templateDeploy.project")}>
                            <PagedPicker<TemplateProjectOption>
                                read={options.templateProjectOptionsAction}
                                scope={{}}
                                cache="template-projects"
                                className="w-full"
                                value={projectId}
                                selectedLabel={project.name}
                                onValueChange={(_, item) => pickProject(item)}
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
