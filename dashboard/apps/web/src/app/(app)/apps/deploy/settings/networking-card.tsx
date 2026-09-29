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
import { useTranslations } from "@/components/i18n/i18n-provider";
import { setEnvironmentNetworkModeAction } from "../project-actions";
import { ENVIRONMENT_NETWORK_MODES, type EnvironmentNetworkMode } from "@polaris/core";
import type { ProjectEnvironmentView, ProjectSettingsView } from "@/lib/deploy-project-service";

const MODE_LABELS = {
    shared: "networking.modes.shared",
    environment: "networking.modes.environment",
    links: "networking.modes.links"
} as const satisfies Record<EnvironmentNetworkMode, string>;

const MODE_HINTS = {
    shared: "networking.hints.shared",
    environment: "networking.hints.environment",
    links: "networking.hints.links"
} as const satisfies Record<EnvironmentNetworkMode, string>;

export function NetworkingCard({ settings, canManage }: { settings: ProjectSettingsView; canManage: boolean }) {
    const t = useTranslations("deploySettings");
    return (
        <SettingsCard title={t("networking.title")} description={t("networking.description")}>
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
    const t = useTranslations("deploySettings");
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
                        ? t("networking.deployingSome", { count: result.started ?? 0, failed: failed.join("; ") })
                        : t("networking.deploying", { count: result.started ?? 0 })
                );
            } else {
                setOutcome(t("networking.saved"));
            }
            router.refresh();
        });
    }

    return (
        <div className="flex flex-col gap-2 border-b border-border/40 px-3 py-3 last:border-0">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="flex min-w-0 items-center gap-2 text-sm font-medium">
                    <Network className="size-4 text-muted-foreground" />
                    <span className="truncate" title={environment.name}>{environment.name}</span>
                </p>
                <Select
                    value={mode}
                    disabled={!canManage || pending}
                    onValueChange={(value) => {
                        setMode(value as EnvironmentNetworkMode);
                        setOutcome(null);
                    }}
                    options={ENVIRONMENT_NETWORK_MODES.map((value) => ({ value, label: t(MODE_LABELS[value]) }))}
                    className="w-full sm:w-52"
                    aria-label={t("networking.modeLabel", { name: environment.name })}
                />
            </div>
            <p className="text-xs text-muted-foreground">{t(MODE_HINTS[mode])}</p>
            {mode === "links" && environment.linkCount === 0 && (
                <p className="text-xs text-warning">
                    {t("networking.noLinks")}
                </p>
            )}
            {mode !== "shared" && !privateNetworksHere && (
                <p className="text-xs text-warning">
                    {t("networking.needsUpdate")}
                </p>
            )}
            {dirty && environment.networkMode === "shared" && (
                <p className="text-xs text-muted-foreground">
                    {t("networking.leavesShared")}
                </p>
            )}
            {error && <p className="text-sm text-danger">{error}</p>}
            {outcome && <p className="text-xs text-muted-foreground">{outcome}</p>}
            {canManage && dirty && (
                <div className="flex flex-wrap justify-end gap-2">
                    <Button variant="ghost" onClick={() => setMode(environment.networkMode)} disabled={pending}>
                        {t("networking.cancel")}
                    </Button>
                    <Button variant="secondary" onClick={() => save(false)} disabled={pending}>
                        {pending && !deploying && <Loader2 className="size-4 animate-spin" />} {t("networking.save")}
                    </Button>
                    <Button onClick={() => save(true)} disabled={pending || environment.serviceCount === 0}>
                        {pending && deploying && <Loader2 className="size-4 animate-spin" />} {t("networking.saveDeploy")}
                    </Button>
                </div>
            )}
        </div>
    );
}
