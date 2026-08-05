"use client";

/**
 * The two tiers above a repository.
 *
 * The general tier is always shown, whether or not anybody has saved it, because
 * it is where every repository's answer comes from and a screen that hid it until
 * first use would make the defaults look like they came from nowhere. Account
 * tiers are added on demand, from the accounts this person actually has
 * repositories in.
 *
 * Every field offers "inherit" as well as a value, and the inherited option names
 * what it currently resolves to - one tier up for an account, and the built-in
 * default for the general tier. Reading a settings screen should not require
 * opening a second one to find out what a choice means.
 */

import { Plus, Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { saveAgentDefaultsAction } from "../actions";
import { useMemo, useState, useTransition } from "react";
import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";
import { Badge, Button, Card, CardBody, Input, Select } from "@polaris/ui";
import type { AgentDefaultsView } from "@/lib/agents/agent-defaults-service";
import {
    AGENT_EFFORTS,
    AGENT_EXECUTIONS,
    AGENT_EXECUTION_LABELS,
    AGENT_GATE_MODES,
    AGENT_GATE_MODE_LABELS,
    AGENT_GATE_MODE_NOTES,
    AGENT_PUSH_POLICIES,
    AGENT_PUSH_POLICY_LABELS,
    AGENT_SHELL_POLICIES,
    AGENT_SHELL_POLICY_LABELS,
    DEFAULT_AGENT_POLICY,
    resolveAgentPolicy,
    type AgentExecution,
    type AgentPolicy,
    type AgentPushPolicy,
    type AgentShellPolicy
} from "@polaris/core";

/** What a Select stores for "do not decide this here". Not a valid value of any
 *  setting, so it can never be mistaken for one. */
const INHERIT = "__inherit__";

const GENERAL = "";

/** An empty tier, which is what an account nobody has configured looks like. */
function emptyTier(scope: string): AgentDefaultsView {
    return {
        scope,
        execution: null,
        poolId: null,
        poolName: null,
        model: null,
        effort: null,
        push: null,
        shell: null,
        publicRepos: null,
        privateRepos: null,
        pullRequests: null,
        issues: null,
        gate: null
    };
}

export function SettingsView({
    tiers,
    owners,
    pools,
    providers
}: {
    tiers: AgentDefaultsView[];
    owners: string[];
    pools: Array<{ id: string; name: string }>;
    providers: string[];
}) {
    const [rows, setRows] = useState<AgentDefaultsView[]>(() => {
        const stored = new Map(tiers.map((tier) => [tier.scope, tier]));
        // The general tier always exists on the screen even when it has never
        // been saved: it is where everything below it inherits from.
        const general = stored.get(GENERAL) ?? emptyTier(GENERAL);
        return [general, ...tiers.filter((tier) => tier.scope !== GENERAL)];
    });
    const [adding, setAdding] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const general = rows.find((row) => row.scope === GENERAL) ?? emptyTier(GENERAL);
    const configured = new Set(rows.map((row) => row.scope));
    const addable = owners.filter((owner) => !configured.has(owner));

    const update = (scope: string, next: AgentDefaultsView) => {
        setRows((current) => current.map((row) => (row.scope === scope ? next : row)));
    };

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}

            {rows.map((row) => (
                <TierCard
                    key={row.scope}
                    tier={row}
                    // The general tier resolves against the built-in defaults; an
                    // account tier resolves against the general one.
                    inherited={
                        row.scope === GENERAL
                            ? DEFAULT_AGENT_POLICY
                            : resolveAgentPolicy({
                                  publicRepos: general.publicRepos,
                                  privateRepos: general.privateRepos,
                                  pullRequests: general.pullRequests,
                                  issues: general.issues,
                                  gate: general.gate as AgentPolicy["gate"] | null
                              })
                    }
                    inheritedFrom={row.scope === GENERAL ? "the built-in defaults" : "the general settings"}
                    pools={pools}
                    providers={providers}
                    onChange={(next) => update(row.scope, next)}
                    onRemoved={() => setRows((current) => current.filter((entry) => entry.scope !== row.scope))}
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

function TierCard({
    tier,
    inherited,
    inheritedFrom,
    pools,
    providers,
    onChange,
    onRemoved,
    onError
}: {
    tier: AgentDefaultsView;
    inherited: AgentPolicy;
    inheritedFrom: string;
    pools: Array<{ id: string; name: string }>;
    providers: string[];
    onChange: (next: AgentDefaultsView) => void;
    onRemoved: () => void;
    onError: (message: string | null) => void;
}) {
    const [pending, startTransition] = useTransition();
    const [saved, setSaved] = useState(false);

    const models = useMemo(
        () =>
            providers
                .map((slug) => MODEL_INTEGRATIONS.find((entry) => entry.slug === slug)?.defaultModel)
                .filter((entry): entry is { label: string; slug: string } => Boolean(entry)),
        [providers]
    );

    const set = <K extends keyof AgentDefaultsView>(key: K, value: AgentDefaultsView[K]) => {
        setSaved(false);
        onChange({ ...tier, [key]: value });
    };

    const save = () => {
        onError(null);
        startTransition(() => {
            void (async () => {
                const result = await runAction(
                    () =>
                        saveAgentDefaultsAction({
                            scope: tier.scope,
                            execution: tier.execution,
                            poolId: tier.poolId,
                            model: tier.model,
                            effort: tier.effort,
                            push: tier.push,
                            shell: tier.shell,
                            publicRepos: tier.publicRepos,
                            privateRepos: tier.privateRepos,
                            pullRequests: tier.pullRequests,
                            issues: tier.issues,
                            gate: tier.gate
                        }),
                    onError
                );
                if (result && !result.error) setSaved(true);
            })();
        });
    };

    return (
        <Card>
            <CardBody className="space-y-4">
                <div className="flex items-center gap-2">
                    <p className="flex-1 text-sm font-medium">
                        {tier.scope === GENERAL ? "Everything" : tier.scope}
                    </p>
                    {tier.scope === GENERAL ? (
                        <Badge variant="neutral">General</Badge>
                    ) : (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove the settings for ${tier.scope}`}
                            title="Remove these settings"
                            onClick={onRemoved}
                        >
                            <Trash2 className="size-4 shrink-0" />
                        </Button>
                    )}
                </div>

                <p className="text-xs text-muted-foreground">
                    Anything left on Inherit comes from {inheritedFrom}. A repository can still override any of it.
                </p>

                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Public repositories">
                        <BoolSelect
                            value={tier.publicRepos}
                            inherited={inherited.publicRepos}
                            onChange={(next) => set("publicRepos", next)}
                        />
                    </Field>
                    <Field label="Private repositories">
                        <BoolSelect
                            value={tier.privateRepos}
                            inherited={inherited.privateRepos}
                            onChange={(next) => set("privateRepos", next)}
                        />
                    </Field>
                    <Field
                        label="Pull requests"
                        hint="Whether a pull request can start a run. A direct mention is answered either way."
                    >
                        <BoolSelect
                            value={tier.pullRequests}
                            inherited={inherited.pullRequests}
                            onChange={(next) => set("pullRequests", next)}
                        />
                    </Field>
                    <Field label="Issues">
                        <BoolSelect
                            value={tier.issues}
                            inherited={inherited.issues}
                            onChange={(next) => set("issues", next)}
                        />
                    </Field>
                </div>

                <Field label="Quality gate" hint={AGENT_GATE_MODE_NOTES[(tier.gate as AgentPolicy["gate"]) ?? inherited.gate]}>
                    <Select
                        value={tier.gate ?? INHERIT}
                        onValueChange={(next) => set("gate", next === INHERIT ? null : next)}
                        options={[
                            { value: INHERIT, label: `Inherit (${AGENT_GATE_MODE_LABELS[inherited.gate]})` },
                            ...AGENT_GATE_MODES.map((value) => ({ value, label: AGENT_GATE_MODE_LABELS[value] }))
                        ]}
                    />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Runs on">
                        <Select
                            value={tier.execution ?? INHERIT}
                            onValueChange={(next) => set("execution", next === INHERIT ? null : (next as AgentExecution))}
                            options={[
                                { value: INHERIT, label: "Inherit" },
                                ...AGENT_EXECUTIONS.map((value) => ({
                                    value,
                                    label: AGENT_EXECUTION_LABELS[value]
                                }))
                            ]}
                        />
                    </Field>
                    {tier.execution === "runners" ? (
                        <Field
                            label="Runner pool"
                            hint={pools.length === 0 ? "You have no pools yet. Create one under Apps > Runners." : undefined}
                        >
                            <Select
                                value={tier.poolId ?? ""}
                                onValueChange={(next) => set("poolId", next || null)}
                                placeholder="Pick a runner pool"
                                options={pools.map((pool) => ({ value: pool.id, label: pool.name }))}
                            />
                        </Field>
                    ) : null}
                    <Field
                        label="Model"
                        hint={models.length === 0 ? "Connect a model provider under Integrations first." : undefined}
                    >
                        {models.length === 0 ? (
                            <Input
                                value={tier.model ?? ""}
                                onChange={(event) => set("model", event.target.value || null)}
                                placeholder="Inherit"
                            />
                        ) : (
                            <Select
                                value={tier.model ?? INHERIT}
                                onValueChange={(next) => set("model", next === INHERIT ? null : next)}
                                options={[
                                    { value: INHERIT, label: "Inherit" },
                                    ...models.map((entry) => ({ value: entry.slug, label: entry.label }))
                                ]}
                            />
                        )}
                    </Field>
                    <Field label="Reasoning effort">
                        <Select
                            value={tier.effort ?? INHERIT}
                            onValueChange={(next) => set("effort", next === INHERIT ? null : next)}
                            options={[
                                { value: INHERIT, label: "Inherit" },
                                ...AGENT_EFFORTS.map((value) => ({ value, label: value }))
                            ]}
                        />
                    </Field>
                    <Field label="Git access">
                        <Select
                            value={tier.push ?? INHERIT}
                            onValueChange={(next) => set("push", next === INHERIT ? null : (next as AgentPushPolicy))}
                            options={[
                                { value: INHERIT, label: "Inherit" },
                                ...AGENT_PUSH_POLICIES.map((value) => ({
                                    value,
                                    label: AGENT_PUSH_POLICY_LABELS[value]
                                }))
                            ]}
                        />
                    </Field>
                    <Field label="Shell">
                        <Select
                            value={tier.shell ?? INHERIT}
                            onValueChange={(next) => set("shell", next === INHERIT ? null : (next as AgentShellPolicy))}
                            options={[
                                { value: INHERIT, label: "Inherit" },
                                ...AGENT_SHELL_POLICIES.map((value) => ({
                                    value,
                                    label: AGENT_SHELL_POLICY_LABELS[value]
                                }))
                            ]}
                        />
                    </Field>
                </div>

                <div className="flex items-center justify-end gap-3">
                    {saved ? <span className="text-xs text-emerald-400">Saved</span> : null}
                    <Button size="sm" onClick={save} disabled={pending}>
                        {pending ? "Saving..." : "Save"}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
    return (
        <div className="space-y-1">
            <label className="text-sm font-medium">{label}</label>
            {children}
            {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
    );
}

function BoolSelect({
    value,
    inherited,
    onChange
}: {
    value: boolean | null;
    inherited: boolean;
    onChange: (next: boolean | null) => void;
}) {
    return (
        <Select
            value={value === null ? INHERIT : String(value)}
            onValueChange={(next) => onChange(next === INHERIT ? null : next === "true")}
            options={[
                { value: INHERIT, label: `Inherit (${inherited ? "On" : "Off"})` },
                { value: "true", label: "On" },
                { value: "false", label: "Off" }
            ]}
        />
    );
}
