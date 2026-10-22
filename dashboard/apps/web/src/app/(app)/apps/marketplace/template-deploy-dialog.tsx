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
import { listTemplateTargetsAction, type TemplateTarget } from "../deploy/actions";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
    SearchableSelect,
    Select
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
    const [targets, setTargets] = useState<TemplateTarget[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [projectId, setProjectId] = useState("");
    const [environmentId, setEnvironmentId] = useState("");
    const [chosen, setChosen] = useState(false);

    useEffect(() => {
        void listTemplateTargetsAction()
            .then((list) => {
                setTargets(list);
                const first = list[0];
                if (!first) return;
                setProjectId(first.id);
                setEnvironmentId(
                    first.environments.find((env) => env.isDefault)?.id ??
                        first.environments[0]?.id ??
                        ""
                );
            })
            .catch(() => setFailed(true));
    }, []);

    const project = targets?.find((item) => item.id === projectId);

    function pickProject(id: string) {
        setProjectId(id);
        const next = targets?.find((item) => item.id === id);
        setEnvironmentId(
            next?.environments.find((env) => env.isDefault)?.id ?? next?.environments[0]?.id ?? ""
        );
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
                ) : targets === null ? (
                    <div className="flex justify-center py-6" aria-busy>
                        <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                ) : targets.length === 0 ? (
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
                            <SearchableSelect
                                className="w-full"
                                value={projectId}
                                onValueChange={pickProject}
                                aria-label={t("templateDeploy.project")}
                                searchPlaceholder={t("templateDeploy.projectSearch")}
                                emptyText={t("templateDeploy.projectNone")}
                                options={targets.map((item) => ({
                                    value: item.id,
                                    label: item.name
                                }))}
                            />
                        </Field>
                        {project && project.environments.length > 1 ? (
                            <Field label={t("templateDeploy.environment")}>
                                <Select
                                    value={environmentId}
                                    onValueChange={setEnvironmentId}
                                    aria-label={t("templateDeploy.environment")}
                                    options={project.environments.map((env) => ({
                                        value: env.id,
                                        label: env.name
                                    }))}
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
