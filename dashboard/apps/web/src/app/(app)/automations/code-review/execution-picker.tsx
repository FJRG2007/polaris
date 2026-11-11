"use client";

import { Sparkles } from "lucide-react";
import { Badge, Select } from "@polaris/ui";
import { AGENT_EXECUTIONS, type AgentExecution, type ExecutionAdvice } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentText, agentWord } from "@/lib/agents/words";
import type { NamespaceTranslator } from "@/lib/i18n/types";

/**
 * Where a repository's runs happen.
 *
 * All three are always pickable. An option Polaris cannot serve today is still a
 * decision somebody is entitled to make - a runner pool that does not exist yet
 * gets created, a container engine that is off gets turned on - and greying it
 * out left a screen that named two choices and offered one, with no route from
 * one state to the other. What a blocker gets instead is the reason and the way
 * out of it, stated where the choice is made.
 */
export function ExecutionPicker({
    value,
    advice,
    pools,
    allPools,
    poolId,
    onChange,
    onPoolChange
}: {
    value: AgentExecution;
    advice: ExecutionAdvice | null;
    /** Pools that already cover this repository. */
    pools: Array<{ id: string; name: string }>;
    /** Every pool this person has. A pool that does not cover the repository yet
     *  is still worth offering: widening its scope is a smaller step than
     *  building a machine, and the alternative is a field with nothing in it. */
    allPools: Array<{ id: string; name: string }>;
    poolId: string | null;
    onChange: (next: AgentExecution) => void;
    onPoolChange: (next: string | null) => void;
}) {
    const t = useTranslations("agents");
    const blocked = advice?.unavailable ?? {};
    const covering = new Set(pools.map((pool) => pool.id));
    const offered = allPools.length > 0 ? allPools : pools;

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium">{t("repos.runsOn")}</label>
            <Select
                value={value}
                onValueChange={(next) => onChange(next as AgentExecution)}
                options={AGENT_EXECUTIONS.map((execution) => ({
                    value: execution,
                    label: agentWord(t, "execution", execution)
                }))}
            />
            <p className="text-xs text-muted-foreground">{agentWord(t, "executionNote", value)}</p>

            {advice && advice.execution === value ? (
                <p className="flex items-start gap-1.5 text-xs text-success">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                    {agentText(t, advice.reason)}
                </p>
            ) : advice ? (
                <p className="text-xs text-muted-foreground">
                    {t("repoDialog.suggests", {
                        execution: agentWord(t, "execution", advice.execution),
                        reason: agentText(t, advice.reason)
                    })}
                </p>
            ) : null}

            {blocked[value] ? (
                <p className="text-xs text-warning">
                    {agentText(t, blocked[value] ?? "")} {fix(value, t)}
                </p>
            ) : null}

            {value === "runners" ? (
                offered.length > 0 ? (
                    <div className="space-y-1 pt-2">
                        <label className="text-sm font-medium">{t("repoDialog.pool")}</label>
                        <Select
                            value={poolId ?? ""}
                            onValueChange={(next) => onPoolChange(next || null)}
                            placeholder={t("text.pickPool")}
                            options={offered.map((pool) => ({
                                value: pool.id,
                                // A pool that does not serve this repository yet is
                                // offered and labelled as such, rather than silently
                                // producing a job nothing picks up.
                                label: covering.has(pool.id) ? pool.name : t("repoDialog.notCovering", { name: pool.name })
                            }))}
                        />
                        {poolId && !covering.has(poolId) ? (
                            <p className="text-xs text-warning">{t("repoDialog.widen")}</p>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-xs text-warning">{t("repoDialog.noPools")}</p>
                )
            ) : null}

            {/* Every blocker, not only the one on the current choice: somebody
                deciding between three options wants to know what each would need. */}
            {Object.entries(blocked)
                .filter(([execution]) => execution !== value)
                .map(([execution, reason]) => (
                    <p key={execution} className="text-xs text-muted-foreground">
                        <Badge variant="neutral" className="mr-1.5">
                            {agentWord(t, "execution", execution)}
                        </Badge>
                        {agentText(t, reason ?? "")} {fix(execution as AgentExecution, t)}
                    </p>
                ))}
        </div>
    );
}

/** What to do about a blocked execution. Every blocker has a fix, and naming it
 *  is the difference between a warning and a dead end. */
function fix(execution: AgentExecution, t: NamespaceTranslator<"agents">): string {
    switch (execution) {
        case "actions":
            return t("repoDialog.fix.actions");
        case "runners":
            return t("repoDialog.fix.runners");
        case "server":
            return t("repoDialog.fix.server");
    }
}
