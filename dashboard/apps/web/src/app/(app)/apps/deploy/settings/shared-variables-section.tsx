"use client";

/**
 * Shared variables: values every service in one environment gets, without having
 * to be set on each of them.
 *
 * The same editor as a service's own variables: edits are saved as one batch,
 * a secret nobody typed over is never sent back, and saving leaves the choice
 * of redeploying now or with the next deploy - a variable that has been saved
 * but is not in effect is said so on screen until it is.
 */

import { useState } from "react";
import { Plus } from "lucide-react";
import { Button, Select } from "@polaris/ui";
import { SettingsCard } from "../project-settings";
import { VariablesEditor } from "../variables-editor";
import type { ProjectSettingsView } from "@/lib/deploy-project-service";
import {
    NEW_ENVIRONMENT,
    NewEnvironmentDialog,
    newEnvironmentOption
} from "../new-environment-dialog";

export function SharedVariablesSection({
    settings,
    canManage
}: {
    settings: ProjectSettingsView;
    canManage: boolean;
}) {
    const first =
        settings.environments.find((environment) => environment.isDefault) ??
        settings.environments[0];
    const [environmentId, setEnvironmentId] = useState(first?.id ?? "");
    const [creating, setCreating] = useState(false);
    const environment = settings.environments.find((one) => one.id === environmentId);

    /** Picking the create option opens the dialog instead of switching to it. */
    function selectEnvironment(id: string) {
        if (id === NEW_ENVIRONMENT) setCreating(true);
        else setEnvironmentId(id);
    }

    if (!first) {
        return (
            <>
                <SettingsCard
                    title="Shared variables"
                    description="Values every service in an environment receives."
                >
                    <p className="text-sm text-muted-foreground">
                        This project has no environments yet.
                    </p>
                    {canManage && (
                        <div>
                            <Button variant="ghost" onClick={() => setCreating(true)}>
                                <Plus className="size-4" /> New environment
                            </Button>
                        </div>
                    )}
                </SettingsCard>
                <NewEnvironmentDialog
                    projectId={settings.id}
                    open={creating}
                    onOpenChange={setCreating}
                    onCreated={setEnvironmentId}
                />
            </>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <SettingsCard
                title="Shared variables"
                description="Set once per environment and delivered to every service in it. A service's own variable of the same name wins."
            >
                <Select
                    value={environmentId}
                    onValueChange={selectEnvironment}
                    options={[
                        ...settings.environments.map((one) => ({ value: one.id, label: one.name })),
                        ...newEnvironmentOption(canManage)
                    ]}
                    className="max-w-xs"
                    aria-label="Environment"
                />
                {environmentId && (
                    <VariablesEditor
                        scope="environment"
                        scopeId={environmentId}
                        canWrite={canManage}
                        canDeploy={canManage}
                        redeployTarget={`every deployed service in ${environment?.name ?? "this environment"}`}
                    />
                )}
            </SettingsCard>

            <NewEnvironmentDialog
                projectId={settings.id}
                open={creating}
                onOpenChange={setCreating}
                onCreated={setEnvironmentId}
            />
        </div>
    );
}
