"use client";

/**
 * Feature flags: how this project behaves.
 *
 * Every flag here changes what Polaris actually does - there are no display-only
 * toggles - so the catalogue in @polaris/core doubles as the documentation, and
 * this screen is just the switches for it.
 */

import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { Button, Switch } from "@polaris/ui";
import { useState, useTransition } from "react";
import { SettingsCard } from "../project-settings";
import { setProjectFlagsAction } from "../project-actions";
import { PROJECT_FLAGS, type ProjectFlags } from "@polaris/core";
import type { ProjectSettingsView } from "@/lib/deploy-project-service";

export function FeatureFlagsSection({
    settings,
    canManage
}: {
    settings: ProjectSettingsView;
    canManage: boolean;
}) {
    const router = useRouter();
    const [flags, setFlags] = useState<ProjectFlags>(settings.flags);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    const dirty = PROJECT_FLAGS.some((flag) => flags[flag.id] !== settings.flags[flag.id]);

    function save() {
        setError(null);
        startTransition(async () => {
            const result = await setProjectFlagsAction({ projectId: settings.id, flags });
            if (result.error) {
                setError(result.error);
                return;
            }
            router.refresh();
        });
    }

    return (
        <SettingsCard
            title="Feature flags"
            description="These apply to this project only. Changing one affects what happens next, not what already happened."
        >
            <div className="flex flex-col gap-2">
                {PROJECT_FLAGS.map((flag) => (
                    <label
                        key={flag.id}
                        className="flex items-start justify-between gap-3 rounded-md border border-border/60 p-3"
                    >
                        <span className="min-w-0">
                            <span className="block text-sm font-medium">{flag.label}</span>
                            <span className="block text-xs text-muted-foreground">{flag.description}</span>
                        </span>
                        <Switch
                            checked={flags[flag.id]}
                            disabled={!canManage}
                            aria-label={flag.label}
                            onChange={(next) => setFlags((current) => ({ ...current, [flag.id]: next }))}
                        />
                    </label>
                ))}
            </div>

            {error && <p className="text-sm text-danger">{error}</p>}

            {canManage && (
                <div className="flex justify-end">
                    <Button onClick={save} disabled={pending || !dirty}>
                        {pending && <Loader2 className="size-4 animate-spin" />} Save flags
                    </Button>
                </div>
            )}
        </SettingsCard>
    );
}
