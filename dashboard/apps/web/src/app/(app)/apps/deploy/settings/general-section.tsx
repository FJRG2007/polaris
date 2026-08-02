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
import type { ProjectSettingsView } from "@/lib/deploy-project-service";
import { PROJECT_VISIBILITIES, type ProjectVisibility } from "@polaris/core";
import { exportProjectTemplateAction, setProjectVisibilityAction, updateProjectGeneralAction } from "../project-actions";

const VISIBILITY_LABELS: Record<ProjectVisibility, string> = {
    private: "Private",
    internal: "Internal"
};

const VISIBILITY_HINTS: Record<ProjectVisibility, string> = {
    private: "Only the owner and the people added to this project can see it.",
    internal: "Anyone signed in to this Polaris who can read Deploy can see it. Still nobody from the internet."
};

export function GeneralSection({ settings, canManage }: { settings: ProjectSettingsView; canManage: boolean }) {
    const router = useRouter();
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
            <SettingsCard title="Project info" description="The name is what containers and free subdomains are derived from.">
                <div className="flex flex-col gap-3">
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Name</span>
                        <Input
                            value={name}
                            disabled={!canManage}
                            onChange={(event) => setName(event.target.value)}
                            placeholder="my-project"
                        />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Description</span>
                        <Input
                            value={description}
                            disabled={!canManage}
                            onChange={(event) => setDescription(event.target.value)}
                            placeholder="What this project is for"
                        />
                    </label>
                    <div className="flex flex-col gap-1.5">
                        <span className="text-xs font-medium text-muted-foreground">Project ID</span>
                        <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 truncate rounded-md border border-border/60 bg-muted/40 px-2.5 py-2 font-mono text-xs">
                                {settings.id}
                            </code>
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={copyId}
                                aria-label="Copy project ID"
                                title="Copy project ID"
                            >
                                {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
                            </Button>
                        </div>
                    </div>
                    {error && <p className="text-sm text-danger">{error}</p>}
                    {canManage && (
                        <div className="flex justify-end">
                            <Button onClick={save} disabled={pending || !dirty || !name.trim()}>
                                {pending && <Loader2 className="size-4 animate-spin" />} Update
                            </Button>
                        </div>
                    )}
                </div>
            </SettingsCard>

            <SettingsCard title="Visibility" description={VISIBILITY_HINTS[visibility]}>
                <Select
                    value={visibility}
                    disabled={!canManage}
                    onValueChange={(value) => changeVisibility(value as ProjectVisibility)}
                    options={PROJECT_VISIBILITIES.map((value) => ({ value, label: VISIBILITY_LABELS[value] }))}
                    className="max-w-xs"
                    aria-label="Visibility"
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
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    function download() {
        setError(null);
        startTransition(async () => {
            const result = await exportProjectTemplateAction(projectId);
            if (result.error || !result.template) {
                setError(result.error ?? "Could not build the template");
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
            title="Template"
            description="The project written out as a portable description of itself: environments, services, volumes, and the names of the variables each one needs."
        >
            <p className="text-xs text-muted-foreground">
                Variable values are left out on purpose, so the file is safe to hand to somebody else.
            </p>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex justify-end">
                <Button variant="secondary" onClick={download} disabled={pending || !canManage}>
                    {pending ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                    Export template
                </Button>
            </div>
        </SettingsCard>
    );
}
