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

import * as core from "@polaris/core";
import { Trash2 } from "lucide-react";
import { runAction } from "@/lib/run-action";
import { useState, useTransition } from "react";
import { Badge, Button, Card, CardBody, Select } from "@polaris/ui";
import { ModelFallbackList } from "@/components/model-fallback-list";
import { ModelPicker, type PickerModel } from "@/components/model-picker";
import type { AgentDefaultsView } from "@/lib/agents/agent-defaults-service";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentWord } from "@/lib/agents/words";
import type { NamespaceKey } from "@/lib/i18n/types";
import {
    AGENT_EFFORTS,
    AGENT_EXECUTIONS,
    AGENT_GATE_MODES,
    AGENT_PUSH_POLICIES,
    AGENT_SHELL_POLICIES,
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

/** A three-state choice rendered by a Select, because a switch has two states and
 *  "inherit" is the third one every tier here needs. */
function enigmaChoice(enabled: boolean | null): string {
    if (enabled === null) return INHERIT;
    return enabled ? "on" : "off";
}

/** A tier that decides nothing, which is what one nobody has configured looks
 *  like. */
export function emptyTier(scope: string): AgentDefaultsView {
    return {
        scope,
        execution: null,
        poolId: null,
        poolName: null,
        enigma: core.INHERIT_ENIGMA,
        model: null,
        fallback: null,
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
    /** The catalogue, read through this screen's own permission - the same
     *  reason `save` is a prop. */
    loadModels: () => Promise<PickerModel[]>;
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
    loadModels,
    save: store,
    onChange,
    onRemoved,
    onError
}: AgentDefaultsCardProps) {
    // Drawn only on the Agents screens, which load the `agents` catalog.
    const t = useTranslations("agents");
    const [pending, startTransition] = useTransition();
    const [saved, setSaved] = useState(false);

    const set = <K extends keyof AgentDefaultsView>(key: K, value: AgentDefaultsView[K]) => {
        setSaved(false);
        onChange({ ...tier, [key]: value });
    };

    /** One field of the Enigma block, leaving the rest of it alone - it is stored
     *  as one value, so setting a field means rewriting the whole thing. */
    const setEnigma = <K extends keyof core.EnigmaSettings>(
        key: K,
        value: core.EnigmaSettings[K]
    ) => {
        setSaved(false);
        onChange({ ...tier, enigma: { ...tier.enigma, [key]: value } });
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
                            fallback: tier.fallback,
                            enigma: tier.enigma,
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
                            aria-label={t("defaultsCard.removeNamed", { title })}
                            title={t("defaultsCard.remove")}
                            onClick={onRemoved}
                        >
                            <Trash2 className="size-4 shrink-0" />
                        </Button>
                    ) : (
                        <Badge variant="neutral">{t("defaultsCard.inheritsThis")}</Badge>
                    )}
                </div>

                <p className="text-xs text-muted-foreground">{t("defaultsCard.intro", { from: inheritedFrom })}</p>

                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("defaultsCard.publicRepos")}>
                        <BoolSelect
                            value={tier.publicRepos}
                            inherited={inherited.publicRepos}
                            onChange={(next) => set("publicRepos", next)}
                        />
                    </Field>
                    <Field label={t("defaultsCard.privateRepos")}>
                        <BoolSelect
                            value={tier.privateRepos}
                            inherited={inherited.privateRepos}
                            onChange={(next) => set("privateRepos", next)}
                        />
                    </Field>
                    <Field
                        label={t("settingsFields.pullRequests")}
                        hint={t("defaultsCard.pullRequestsHint")}
                    >
                        <BoolSelect
                            value={tier.pullRequests}
                            inherited={inherited.pullRequests}
                            onChange={(next) => set("pullRequests", next)}
                        />
                    </Field>
                    <Field label={t("settingsFields.issues")}>
                        <BoolSelect
                            value={tier.issues}
                            inherited={inherited.issues}
                            onChange={(next) => set("issues", next)}
                        />
                    </Field>
                </div>

                <Field
                    label={t("settingsFields.gate")}
                    hint={agentWord(t, "gateModeNote", tier.gate ?? inherited.gate)}
                >
                    <Select
                        value={tier.gate ?? INHERIT}
                        onValueChange={(next) =>
                            set("gate", next === INHERIT ? null : (next as AgentGateMode))
                        }
                        options={[
                            {
                                value: INHERIT,
                                label: t("settingsFields.inherit", { value: agentWord(t, "gateMode", inherited.gate) })
                            },
                            ...AGENT_GATE_MODES.map((value) => ({
                                value,
                                label: agentWord(t, "gateMode", value)
                            }))
                        ]}
                    />
                </Field>

                <div className="grid gap-4 sm:grid-cols-2">
                    {/* The rest of Enigma. The gate above is the field with a
                        minutes-per-run cost on it and keeps its own place; these
                        two are what an operator changes when they are debugging
                        Enigma itself or want a session to start faster. */}
                    <Field
                        label="Enigma" // i18n-ignore a product's name
                        hint={t("defaultsCard.enigmaHint")}
                    >
                        <Select
                            value={enigmaChoice(tier.enigma.enabled)}
                            onValueChange={(next) =>
                                setEnigma("enabled", next === INHERIT ? null : next === "on")
                            }
                            options={[
                                { value: INHERIT, label: t("defaultsCard.inherit") },
                                { value: "on", label: t("settingsFields.on") },
                                { value: "off", label: t("settingsFields.off") }
                            ]}
                        />
                    </Field>
                    <Field
                        label={t("defaultsCard.howMuch")}
                        hint={t(`defaultsCard.scopeNotes.${tier.enigma.scope ?? "all"}` as NamespaceKey<"agents">)}
                    >
                        <Select
                            value={tier.enigma.scope ?? INHERIT}
                            onValueChange={(next) =>
                                setEnigma(
                                    "scope",
                                    next === INHERIT ? null : (next as core.EnigmaScope)
                                )
                            }
                            options={[
                                { value: INHERIT, label: t("defaultsCard.inherit") },
                                ...core.ENIGMA_SCOPES.map((value) => ({
                                    value,
                                    label: t(`defaultsCard.scopes.${value}` as NamespaceKey<"agents">)
                                }))
                            ]}
                        />
                    </Field>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label={t("repos.runsOn")}>
                        <Select
                            value={tier.execution ?? INHERIT}
                            onValueChange={(next) =>
                                set("execution", next === INHERIT ? null : (next as AgentExecution))
                            }
                            options={[
                                { value: INHERIT, label: t("defaultsCard.inherit") },
                                ...AGENT_EXECUTIONS.map((value) => ({
                                    value,
                                    label: agentWord(t, "execution", value)
                                }))
                            ]}
                        />
                    </Field>
                    {tier.execution === "runners" ? (
                        <Field
                            label={t("repoDialog.pool")}
                            hint={pools.length === 0 ? t("defaultsCard.noPools") : undefined}
                        >
                            <Select
                                value={tier.poolId ?? ""}
                                onValueChange={(next) => set("poolId", next || null)}
                                placeholder={t("text.pickPool")}
                                options={pools.map((pool) => ({
                                    value: pool.id,
                                    label: pool.name
                                }))}
                            />
                        </Field>
                    ) : null}
                    <Field
                        label={t("repos.model")}
                        hint={providers.length === 0 ? t("repoDialog.connectProvider") : undefined}
                    >
                        <ModelPicker
                            value={tier.model}
                            onChange={(next) => set("model", next)}
                            load={loadModels}
                            inheritLabel={t("settingsFields.inherit", { value: inheritedFrom })}
                        />
                    </Field>
                    <Field
                        wide
                        label={t("defaultsCard.fallback")}
                        hint={t("defaultsCard.fallbackHint")}
                    >
                        <ModelFallbackList
                            value={tier.fallback}
                            onChange={(next) => set("fallback", next)}
                            loadModels={loadModels}
                        />
                    </Field>
                    <Field label={t("repoDialog.effort")}>
                        <Select
                            value={tier.effort ?? INHERIT}
                            onValueChange={(next) =>
                                set("effort", next === INHERIT ? null : (next as AgentEffort))
                            }
                            options={[
                                { value: INHERIT, label: t("defaultsCard.inherit") },
                                ...AGENT_EFFORTS.map((value) => ({ value, label: value }))
                            ]}
                        />
                    </Field>
                    <Field label={t("repoDialog.git")}>
                        <Select
                            value={tier.push ?? INHERIT}
                            onValueChange={(next) =>
                                set("push", next === INHERIT ? null : (next as AgentPushPolicy))
                            }
                            options={[
                                { value: INHERIT, label: t("defaultsCard.inherit") },
                                ...AGENT_PUSH_POLICIES.map((value) => ({
                                    value,
                                    label: agentWord(t, "pushPolicy", value)
                                }))
                            ]}
                        />
                    </Field>
                    <Field label={t("repoDialog.shell")}>
                        <Select
                            value={tier.shell ?? INHERIT}
                            onValueChange={(next) =>
                                set("shell", next === INHERIT ? null : (next as AgentShellPolicy))
                            }
                            options={[
                                { value: INHERIT, label: t("defaultsCard.inherit") },
                                ...AGENT_SHELL_POLICIES.map((value) => ({
                                    value,
                                    label: agentWord(t, "shellPolicy", value)
                                }))
                            ]}
                        />
                    </Field>
                </div>

                <div className="flex items-center justify-end gap-3">
                    {saved ? <span className="text-xs text-success">{t("defaultsCard.saved")}</span> : null}
                    <Button size="sm" onClick={save} disabled={pending}>
                        {pending ? t("rules.saving") : t("rules.save")}
                    </Button>
                </div>
            </CardBody>
        </Card>
    );
}

function Field({
    label,
    hint,
    wide,
    children
}: {
    label: string;
    hint?: string;
    /** Spans the pair of columns the grid lays the rest out in - for a control
     *  that is a list rather than one value. */
    wide?: boolean;
    children: React.ReactNode;
}) {
    return (
        <div className={wide ? "space-y-1 sm:col-span-2" : "space-y-1"}>
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
    const t = useTranslations("agents");
    const yesNo = (on: boolean) => (on ? t("settingsFields.on") : t("settingsFields.off"));
    return (
        <Select
            value={value === null ? INHERIT : String(value)}
            onValueChange={(next) => onChange(next === INHERIT ? null : next === "true")}
            options={[
                { value: INHERIT, label: t("settingsFields.inherit", { value: yesNo(inherited) }) },
                { value: "true", label: t("settingsFields.on") },
                { value: "false", label: t("settingsFields.off") }
            ]}
        />
    );
}
