"use client";

/**
 * How the world is played: what a death costs, what damages you, what the mobs
 * and the weather are allowed to do.
 *
 * Every control here takes effect the moment it is switched. That is not a
 * detail - the same settings exist in `server.properties`, where changing one
 * rebuilds the container and disconnects everybody playing, and this screen is
 * the version of them that does not. So there is no Save button and no pending
 * state: a switch is the change, and what comes back is the server's own answer
 * about what it now is.
 *
 * What is drawn is what this server has. The rules are read from it rather than
 * listed from a version Polaris assumes, so a 1.16 server is not shown three
 * switches that would fail and a 1.21 one is not short of them.
 */

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import type { WorldRules } from "@/lib/apps/minecraft/rules-service";
import { Button, Card, CardBody, Input, Select, Skeleton, Switch, cn } from "@polaris/ui";
import { DIFFICULTIES, ruleGroups, normalizeRuleValue, type GameRule } from "@/lib/apps/minecraft/rules";
import { readWorldRulesAction, setWorldDifficultyAction, setWorldRuleAction } from "./minecraft-actions";

export function MinecraftRules({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    /** False for somebody who may watch the server and not change it. */
    canManage: boolean;
}) {
    const [rules, setRules] = useState<WorldRules | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        const result = await readWorldRulesAction(installedAppId);
        setLoading(false);
        if (result.rules) {
            setRules(result.rules);
            setError(null);
        } else {
            setError(result.error ?? "The rules could not be read");
        }
    }, [installedAppId]);

    useEffect(() => {
        void load();
    }, [load]);

    /** Set one rule and take the server's answer as the truth about it. */
    async function apply(rule: GameRule, value: string): Promise<void> {
        const normalized = normalizeRuleValue(rule, value);
        if (normalized === null) {
            setError(`${rule.label} does not take that value.`);
            return;
        }
        setBusy(rule.id);
        setError(null);
        // Optimistic: the switch moves now and is put back if the server refuses.
        const before = rules?.values[rule.id];
        setRules((current) =>
            current ? { ...current, values: { ...current.values, [rule.id]: normalized } } : current
        );
        const result = await setWorldRuleAction(installedAppId, rule.id, normalized);
        setBusy(null);
        if (result.error) {
            setError(result.error);
            setRules((current) =>
                current && before !== undefined
                    ? { ...current, values: { ...current.values, [rule.id]: before } }
                    : current
            );
            return;
        }
        if (result.value !== undefined && result.value !== normalized) {
            setRules((current) =>
                current ? { ...current, values: { ...current.values, [rule.id]: result.value as string } } : current
            );
        }
    }

    async function applyDifficulty(value: string): Promise<void> {
        const before = rules?.difficulty ?? null;
        setBusy("difficulty");
        setError(null);
        setRules((current) =>
            current ? { ...current, difficulty: value as WorldRules["difficulty"] } : current
        );
        const result = await setWorldDifficultyAction(installedAppId, value);
        setBusy(null);
        if (result.error) {
            setError(result.error);
            setRules((current) => (current ? { ...current, difficulty: before } : current));
        }
    }

    // Only what this server answered for. A rule it has never heard of would be a
    // switch that fails every time it is touched.
    const groups = ruleGroups()
        .map((group) => ({
            ...group,
            rules: group.rules.filter((rule) => rules?.values[rule.id] !== undefined)
        }))
        .filter((group) => group.rules.length > 0);

    return (
        <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm text-muted-foreground">
                    Each of these applies straight away. Nobody is disconnected and the server is not restarted.
                </p>
                <Button
                    size="icon"
                    variant="ghost"
                    className="ml-auto"
                    aria-label="Read the rules again"
                    title="Read the rules again"
                    disabled={loading}
                    onClick={() => {
                        setLoading(true);
                        void load();
                    }}
                >
                    <RefreshCw className={loading ? "size-4 animate-spin" : "size-4"} />
                </Button>
            </div>

            {error ? (
                <Card>
                    <CardBody className="flex items-start gap-2 py-3 text-sm text-danger">
                        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                        <span>{error}</span>
                    </CardBody>
                </Card>
            ) : null}

            {loading ? (
                <div className="flex flex-col gap-2">
                    {Array.from({ length: 6 }, (_, index) => (
                        <Skeleton key={index} className="h-12 w-full" />
                    ))}
                </div>
            ) : rules === null ? null : (
                <>
                    <Card>
                        <CardBody className="flex flex-wrap items-center justify-between gap-3 py-3">
                            <div className="min-w-0">
                                <p className="text-sm font-medium">Difficulty</p>
                                <p className="text-xs text-muted-foreground">
                                    Peaceful removes hostile mobs and stops hunger draining.
                                </p>
                            </div>
                            <Select
                                className="w-40"
                                aria-label="Difficulty"
                                disabled={!canManage || busy === "difficulty"}
                                value={rules.difficulty ?? ""}
                                onValueChange={(value) => void applyDifficulty(value)}
                                options={[
                                    ...(rules.difficulty ? [] : [{ value: "", label: "Unknown" }]),
                                    ...DIFFICULTIES.map((entry) => ({
                                        value: entry,
                                        label: entry.charAt(0).toUpperCase() + entry.slice(1)
                                    }))
                                ]}
                            />
                        </CardBody>
                    </Card>

                    {groups.length === 0 ? (
                        <Card>
                            <CardBody className="py-8 text-center text-sm text-muted-foreground">
                                This server did not report any rules. Java servers from 1.13 answer this; Bedrock
                                cannot be asked from here.
                            </CardBody>
                        </Card>
                    ) : (
                        groups.map((group) => (
                            <div key={group.group} className="flex flex-col gap-1">
                                <p className="px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                                    {group.group}
                                </p>
                                <Card>
                                    <CardBody className="flex flex-col gap-0 py-0">
                                        {group.rules.map((rule, index) => (
                                            <RuleRow
                                                key={rule.id}
                                                rule={rule}
                                                value={rules.values[rule.id] ?? ""}
                                                first={index === 0}
                                                busy={busy === rule.id}
                                                disabled={!canManage}
                                                onChange={(value) => void apply(rule, value)}
                                            />
                                        ))}
                                    </CardBody>
                                </Card>
                            </div>
                        ))
                    )}
                </>
            )}
        </div>
    );
}

function RuleRow({
    rule,
    value,
    first,
    busy,
    disabled,
    onChange
}: {
    rule: GameRule;
    value: string;
    /** The first row carries no divider above it. */
    first: boolean;
    busy: boolean;
    disabled: boolean;
    onChange: (value: string) => void;
}) {
    // An integer is committed on blur and on Enter rather than per keystroke: a
    // command per digit would set the rule to 1, then 12, then 128.
    const [draft, setDraft] = useState(value);
    useEffect(() => setDraft(value), [value]);

    return (
        <div
            className={cn(
                "flex flex-wrap items-center justify-between gap-3 py-3",
                !first && "border-t border-border"
            )}
        >
            <div className="min-w-0 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium">
                    {rule.label}
                    {busy ? <Loader2 className="size-3.5 animate-spin text-muted-foreground" /> : null}
                </p>
                {rule.hint ? <p className="text-xs text-muted-foreground">{rule.hint}</p> : null}
            </div>
            {rule.type === "boolean" ? (
                <Switch
                    aria-label={rule.label}
                    disabled={disabled || busy}
                    checked={value === "true"}
                    onChange={(next) => onChange(next ? "true" : "false")}
                />
            ) : (
                <Input
                    type="number"
                    className="w-24"
                    aria-label={rule.label}
                    disabled={disabled || busy}
                    min={rule.min}
                    max={rule.max}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onBlur={() => draft !== value && onChange(draft)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && draft !== value) onChange(draft);
                    }}
                    title={
                        rule.min !== undefined && rule.max !== undefined
                            ? `${rule.min} to ${rule.max}`
                            : undefined
                    }
                />
            )}
        </div>
    );
}
