"use client";

/**
 * Private networking: which services can reach each other by name, chosen per
 * environment.
 *
 * A running container keeps the networks it started on, so a change is saved and
 * then reaches each service on its next deploy. "Save and deploy" does all of an
 * environment's services at once, which is what somebody tightening an
 * environment usually wants.
 */

import { useRouter } from "next/navigation";
import { Button, Select } from "@polaris/ui";
import { useState, useTransition } from "react";
import { Loader2, Network } from "lucide-react";
import { SettingsCard } from "../project-settings";
import { setEnvironmentNetworkModeAction } from "../project-actions";
import { ENVIRONMENT_NETWORK_MODES, type EnvironmentNetworkMode } from "@polaris/core";
import type { ProjectEnvironmentView, ProjectSettingsView } from "@/lib/deploy-project-service";

const MODE_LABELS: Record<EnvironmentNetworkMode, string> = {
    shared: "Shared network",
    environment: "Own network",
    links: "Canvas links only"
};

const MODE_HINTS: Record<EnvironmentNetworkMode, string> = {
    shared: "Every service joins the network all deployments share, so services in other projects can reach these by name.",
    environment: "Services in this environment reach each other by name. Nothing outside it can.",
    links: "A service reaches only the services it is linked to on the canvas, and a database is reached only through a link."
};

export function NetworkingCard({
    settings,
    canManage
}: {
    settings: ProjectSettingsView;
    canManage: boolean;
}) {
    return (
        <SettingsCard
            title="Private networking"
            description="Which services can reach each other by name. Domains and published ports are not affected."
        >
            <div className="overflow-hidden rounded-md border border-border/60">
                {settings.environments.map((environment) => (
                    <EnvironmentNetworkRow
                        key={environment.id}
                        environment={environment}
                        canManage={canManage}
                        privateNetworksHere={settings.privateNetworksHere}
                    />
                ))}
            </div>
        </SettingsCard>
    );
}

function EnvironmentNetworkRow({
    environment,
    canManage,
    privateNetworksHere
}: {
    environment: ProjectEnvironmentView;
    canManage: boolean;
    privateNetworksHere: boolean;
}) {
    const router = useRouter();
    const [mode, setMode] = useState<EnvironmentNetworkMode>(environment.networkMode);
    const [error, setError] = useState<string | null>(null);
    const [outcome, setOutcome] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const [deploying, setDeploying] = useState(false);
    const dirty = mode !== environment.networkMode;

    function save(apply: boolean) {
        setError(null);
        setOutcome(null);
        setDeploying(apply);
        startTransition(async () => {
            const result = await setEnvironmentNetworkModeAction({
                environmentId: environment.id,
                networkMode: mode,
                apply
            });
            setDeploying(false);
            if (result.error) {
                setError(result.error);
                return;
            }
            if (apply) {
                const failed = result.failed ?? [];
                setOutcome(
                    failed.length > 0
                        ? `Deploying ${result.started ?? 0}. Not started: ${failed.join("; ")}`
                        : `Deploying ${result.started ?? 0} ${result.started === 1 ? "service" : "services"} onto the new setting.`
                );
            } else {
                setOutcome("Saved. Each service moves over on its next deploy.");
            }
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-2 border-b border-border/40 px-3 py-3 last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <Network className="size-4 text-muted-foreground" />
                    <span className="truncate" title={environment.name}>
                        {environment.name}
                    </span>
                </p>
                <Select
                    value={mode}
                    disabled={!canManage || pending}
                    onValueChange={(value) => {
                        setMode(value as EnvironmentNetworkMode);
                        setOutcome(null);
                    }}
                    options={ENVIRONMENT_NETWORK_MODES.map((value) => ({
                        value,
                        label: MODE_LABELS[value]
                    }))}
                    className="w-full sm:w-52"
                    aria-label={`How services in ${environment.name} connect`}
                />
            </div>
            <p className="text-xs text-muted-foreground">{MODE_HINTS[mode]}</p>
            {mode === "links" && environment.linkCount === 0 && (
                <p className="text-xs text-warning">
                    This environment&apos;s canvas has no links yet, so no service would reach
                    another. Link them on the canvas first.
                </p>
            )}
            {mode !== "shared" && !privateNetworksHere && (
                <p className="text-xs text-warning">
                    Services on this server stay on the shared network until Polaris is updated from
                    Settings. Services on your other servers get their own network now.
                </p>
            )}
            {dirty && environment.networkMode === "shared" && (
                <p className="text-xs text-muted-foreground">
                    Anything that reaches these services by name from another project stops reaching
                    them.
                </p>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            {outcome && <p className="text-xs text-muted-foreground">{outcome}</p>}
            {canManage && dirty && (
                <div className="flex flex-wrap justify-end gap-2">
                    <Button
                        variant="ghost"
                        onClick={() => setMode(environment.networkMode)}
                        disabled={pending}
                    >
                        Cancel
                    </Button>
                    <Button variant="secondary" onClick={() => save(false)} disabled={pending}>
                        {pending && !deploying && <Loader2 className="size-4 animate-spin" />} Save
                    </Button>
                    <Button
                        onClick={() => save(true)}
                        disabled={pending || environment.serviceCount === 0}
                    >
                        {pending && deploying && <Loader2 className="size-4 animate-spin" />} Save
                        and deploy
                    </Button>
                </div>
            )}
        </div>
    );
}
