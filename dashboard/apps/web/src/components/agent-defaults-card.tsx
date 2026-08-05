"use client";

/**
 * One tier of Agents defaults, wherever it is being edited.
 *
 * The same card serves a person's own tiers under Apps > Agents and the
 * deployment-wide one under Admin, because they answer identical questions and
 * differ only in who they apply to and who may save them. Which of those it is
 * arrives as props: the label, what an inherited value falls through to, and the
 * action that stores it.
 *
 * Every field offers "inherit" beside its values, and the inherited option names
 * what it currently resolves to. Reading one settings screen should not require
 * opening the one above it to find out what a choice means.
 */

import { Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
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
    type AgentDefaultsInput,
    type AgentEffort,
    type AgentExecution,
    type AgentGateMode,
    type AgentPolicy,
    type AgentPushPolicy,
    type AgentShellPolicy
} from "@polaris/core";

/** What a Select stores for "do not decide this here". Not a valid value of any
 *  setting, so it can never be mistaken for one. */
export const INHERIT = "__inherit__";

/** A tier that decides nothing, which is what one nobody has configured looks
 *  like. */
export function emptyTier(scope: string): AgentDefaultsView {
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

export interface AgentDefaultsCardProps {
    tier: AgentDefaultsView;
    /** What to call this tier on screen. */
    title: string;
    /** What an inherited value falls through to right now, so the option can say
     *  what it means. */
    inherited: AgentPolicy;
    /** Named in the copy, so it is clear which screen the fallback comes from. */
    inheritedFrom: string;
    pools: Array<{ id: string; name: string }>;
    providers: string[];
    /** Stores it. Different screens store to different places, and this is the
     *  only difference between them. */
    save: (input: AgentDefaultsInput) => Promise<{ error?: string }>;
    onChange: (next: AgentDefaultsView) => void;
    /** Absent on a tier that cannot be removed - the catch-all ones, which are
     *  where everything below them inherits from. */
    onRemoved?: (() => void) | undefined;
    onError: (message: string | null) => void;
}

export function AgentDefaultsCard({
    tier,
    title,
    inherited,
    inheritedFrom,
    pools,
    providers,
    save: store,
    onChange,
    onRemoved,
    onError
}: AgentDefaultsCardProps) {
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
                        store({
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
                    <p className="flex-1 text-sm font-medium">{title}</p>
                    {onRemoved ? (
                        <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Remove the settings for ${title}`}
                            title="Remove these settings"
                            onClick={onRemoved}
                        >
                            <Trash2 className="size-4 shrink-0" />
                        </Button>
                    ) : (
                        <Badge variant="neutral">Everything below inherits this</Badge>
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

                <Field label="Quality gate" hint={AGENT_GATE_MODE_NOTES[tier.gate ?? inherited.gate]}>
                    <Select
                        value={tier.gate ?? INHERIT}
                        onValueChange={(next) => set("gate", next === INHERIT ? null : (next as AgentGateMode))}
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
                            onValueChange={(next) => set("effort", next === INHERIT ? null : (next as AgentEffort))}
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
