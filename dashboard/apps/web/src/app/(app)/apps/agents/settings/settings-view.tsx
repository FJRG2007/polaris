"use client";

/**
 * A person's own Agents defaults.
 *
 * Two tiers, both theirs: one catch-all for everything they own, and one per
 * GitHub account when a particular account needs something different. A
 * repository still overrides either.
 *
 * What is deliberately not here is the deployment-wide tier. That one applies to
 * everybody, so it belongs to an administrator and lives under Admin > Agents;
 * this screen only reads it, so an inherited value can still name what it means.
 */

import { Plus } from "lucide-react";
import { useState } from "react";
import { saveAgentDefaultsAction } from "../actions";
import { Button, Card, CardBody, Select } from "@polaris/ui";
import { resolveAgentPolicy, type AgentPolicy } from "@polaris/core";
import type { AgentDefaultsView } from "@/lib/agents/agent-defaults-service";
import { AgentDefaultsCard, emptyTier } from "@/components/agent-defaults-card";

/** This person's catch-all tier. */
const GENERAL = "";

/** What one tier contributes when it is the fallback for another. */
function overrideOf(tier: AgentDefaultsView) {
    return {
        publicRepos: tier.publicRepos,
        privateRepos: tier.privateRepos,
        pullRequests: tier.pullRequests,
        issues: tier.issues,
        gate: tier.gate as AgentPolicy["gate"] | null
    };
}

export function SettingsView({
    tiers,
    owners,
    pools,
    providers,
    platform
}: {
    tiers: AgentDefaultsView[];
    owners: string[];
    pools: Array<{ id: string; name: string }>;
    providers: string[];
    /** The deployment-wide tier, read-only here: it is an administrator's. */
    platform: AgentDefaultsView;
}) {
    const [rows, setRows] = useState<AgentDefaultsView[]>(() => {
        const stored = new Map(tiers.map((tier) => [tier.scope, tier]));
        // The catch-all tier is always on the screen even when it has never been
        // saved: it is where everything below it inherits from.
        return [stored.get(GENERAL) ?? emptyTier(GENERAL), ...tiers.filter((tier) => tier.scope !== GENERAL)];
    });
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const general = rows.find((row) => row.scope === GENERAL) ?? emptyTier(GENERAL);
    const configured = new Set(rows.map((row) => row.scope));
    const addable = owners.filter((owner) => !configured.has(owner));

    // The catch-all tier falls through to the deployment; an account tier falls
    // through to the catch-all and then the deployment.
    const fromPlatform = resolveAgentPolicy(overrideOf(platform));
    const fromGeneral = resolveAgentPolicy(overrideOf(general), overrideOf(platform));

    const update = (scope: string, next: AgentDefaultsView) =>
        setRows((current) => current.map((row) => (row.scope === scope ? next : row)));

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            {rows.map((row) => (
                <AgentDefaultsCard
                    key={row.scope}
                    tier={row}
                    title={row.scope === GENERAL ? "All your repositories" : row.scope}
                    inherited={row.scope === GENERAL ? fromPlatform : fromGeneral}
                    inheritedFrom={
                        row.scope === GENERAL ? "the deployment's defaults" : "your settings for all repositories"
                    }
                    pools={pools}
                    providers={providers}
                    save={saveAgentDefaultsAction}
                    onChange={(next) => update(row.scope, next)}
                    onRemoved={
                        row.scope === GENERAL
                            ? undefined
                            : () => setRows((current) => current.filter((entry) => entry.scope !== row.scope))
                    }
                    onError={setError}
                />
            ))}

            {adding ? (
                <Card>
                    <CardBody className="space-y-3">
                        <p className="text-sm font-medium">Settings for one account</p>
                        {addable.length === 0 ? (
                            <p className="text-sm text-muted-foreground">
                                Every account you have repositories in already has its own settings.
                            </p>
                        ) : (
                            <Select
                                value=""
                                onValueChange={(scope) => {
                                    setRows((current) => [...current, emptyTier(scope)]);
                                    setAdding(false);
                                }}
                                placeholder="Pick an account"
                                options={addable.map((owner) => ({ value: owner, label: owner }))}
                            />
                        )}
                        <div className="flex justify-end">
                            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
                                Cancel
                            </Button>
                        </div>
                    </CardBody>
                </Card>
            ) : (
                <Button variant="ghost" size="sm" onClick={() => setAdding(true)} disabled={addable.length === 0}>
                    <Plus className="size-4 shrink-0" />
                    Settings for one account
                </Button>
            )}
        </div>
    );
}
