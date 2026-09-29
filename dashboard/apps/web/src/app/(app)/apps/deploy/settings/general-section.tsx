"use client";

/**
 * General: what the project is called, what it is for, who can see it, and the
 * template it can be exported as.
 *
 * The template is deliberately shape-only. It is a thing people pass around, and
 * one that carried a database password would be a leak with a share button on it -
 * so it names the variables each service needs and leaves the values out.
 */

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { SettingsCard } from "../project-settings";
import { Button, Input, Select } from "@polaris/ui";
import { Check, Copy, Download, Loader2 } from "lucide-react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { ProjectSettingsView } from "@/lib/deploy-project-service";
import { PROJECT_VISIBILITIES, type ProjectVisibility } from "@polaris/core";
import { exportProjectTemplateAction, setProjectVisibilityAction, updateProjectGeneralAction } from "../project-actions";

const VISIBILITY_LABELS = {
    private: "general.visibility.private",
    internal: "general.visibility.internal"
} as const satisfies Record<ProjectVisibility, string>;

const VISIBILITY_HINTS = {
    private: "general.visibility.privateHint",
    internal: "general.visibility.internalHint"
} as const satisfies Record<ProjectVisibility, string>;

export function GeneralSection({ settings, canManage }: { settings: ProjectSettingsView; canManage: boolean }) {
    const router = useRouter();
    const t = useTranslations("deploySettings");
    const [name, setName] = useState(settings.name);
    const [description, setDescription] = useState(settings.description);
    const [visibility, setVisibility] = useState<ProjectVisibility>(settings.visibility);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    // Dirty means the values differ from what was loaded, not that a field was
    // touched - editing a name back to what it was leaves Update disabled.
    const dirty = name.trim() !== settings.name || description.trim() !== settings.description;

    function save() {
        setError(null);
        startTransition(async () => {
            const result = await updateProjectGeneralAction({
                projectId: settings.id,
                name: name.trim(),
                description: description.trim()
            });
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    function changeVisibility(next: ProjectVisibility) {
        setVisibility(next);
        setError(null);
        startTransition(async () => {
            const result = await setProjectVisibilityAction({ projectId: settings.id, visibility: next });
            if (result.error) {
                setError(result.error);
                setVisibility(settings.visibility);
                return;
            }
            router.refresh();
        });
    }

    function copyId() {
        void navigator.clipboard?.writeText(settings.id).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        });
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard title={t("general.info")} description={t("general.infoHint")}>
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("general.name")}</span>
                        <Input
                            value={name}
                            disabled={!canManage}
                            onChange={(event) => setName(event.target.value)}
                            // i18n-ignore: an example project name
                            placeholder="my-project"
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("general.description")}</span>
                        <Input
                            value={description}
                            disabled={!canManage}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder={t("general.descriptionPlaceholder")}
                        />
                    </label>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">{t("general.projectId")}</span>
                        <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-xs">
                                {settings.id}
                            </code>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={copyId}
                                aria-label={t("general.copyId")}
                                title={t("general.copyId")}
                            >
                                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                            </Button>
                        </div>
                    </div>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    {canManage && (
                        <div className="flex justify-end">
                            <Button onClick={save} disabled={pending || !dirty || !name.trim()}>
                                {pending && <Loader2 className="size-4 animate-spin" />} {t("general.update")}
                            </Button>
                        </div>
                    )}
                </div>
            </SettingsCard>

            <SettingsCard title={t("general.visibility.title")} description={t(VISIBILITY_HINTS[visibility])}>
                <Select
                    value={visibility}
                    disabled={!canManage}
                    onValueChange={(value) => changeVisibility(value as ProjectVisibility)}
                    options={PROJECT_VISIBILITIES.map((value) => ({ value, label: t(VISIBILITY_LABELS[value]) }))}
                    className="max-w-xs"
                    aria-label={t("general.visibility.title")}
                />
            </SettingsCard>

            <TemplateCard projectId={settings.id} projectName={settings.slug} canManage={canManage} />
        </div>
    );
}

function TemplateCard({
    projectId,
    projectName,
    canManage
}: {
    projectId: string;
    projectName: string;
    canManage: boolean;
}) {
    const t = useTranslations("deploySettings");
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function download() {
        setError(null);
        startTransition(async () => {
            const result = await exportProjectTemplateAction(projectId);
            if (result.error || !result.template) {
                setError(result.error ?? t("general.template.failed"));
                return;
            }
            const blob = new Blob([result.template], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement("a");
            anchor.href = url;
            anchor.download = `${projectName}-template.json`;
            anchor.click();
            URL.revokeObjectURL(url);
        });
    }

    return (
        <SettingsCard
            title={t("general.template.title")}
            description={t("general.template.description")}
        >
            <p className="text-xs text-muted-foreground">{t("general.template.safe")}</p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button variant="secondary" onClick={download} disabled={pending || !canManage}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    {t("general.template.export")}
                </Button>
            </div>
        </SettingsCard>
    );
}
