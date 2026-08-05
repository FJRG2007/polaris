"use client";

import { Sparkles } from "lucide-react";
import { Badge, Select } from "@polaris/ui";
import {
    AGENT_EXECUTIONS,
    AGENT_EXECUTION_LABELS,
    AGENT_EXECUTION_NOTES,
    type AgentExecution,
    type ExecutionAdvice
} from "@polaris/core";

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
    const blocked = advice?.unavailable ?? {};
    const covering = new Set(pools.map((pool) => pool.id));
    const offered = allPools.length > 0 ? allPools : pools;

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium">Runs on</label>
            <Select
                value={value}
                onValueChange={(next) => onChange(next as AgentExecution)}
                options={AGENT_EXECUTIONS.map((execution) => ({
                    value: execution,
                    label: AGENT_EXECUTION_LABELS[execution]
                }))}
            />
            <p className="text-xs text-muted-foreground">{AGENT_EXECUTION_NOTES[value]}</p>

            {advice && advice.execution === value ? (
                <p className="flex items-start gap-1.5 text-xs text-emerald-400">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0" />
                    {advice.reason}
                </p>
            ) : advice ? (
                <p className="text-xs text-muted-foreground">
                    Polaris suggests {AGENT_EXECUTION_LABELS[advice.execution]}: {advice.reason}
                </p>
            ) : null}

            {blocked[value] ? (
                <p className="text-xs text-amber-400">
                    {blocked[value]} {fix(value)}
                </p>
            ) : null}

            {value === "runners" ? (
                offered.length > 0 ? (
                    <div className="space-y-1 pt-2">
                        <label className="text-sm font-medium">Runner pool</label>
                        <Select
                            value={poolId ?? ""}
                            onValueChange={(next) => onPoolChange(next || null)}
                            placeholder="Pick a runner pool"
                            options={offered.map((pool) => ({
                                value: pool.id,
                                // A pool that does not serve this repository yet is
                                // offered and labelled as such, rather than silently
                                // producing a job nothing picks up.
                                label: covering.has(pool.id) ? pool.name : `${pool.name} - does not cover this repository yet`
                            }))}
                        />
                        {poolId && !covering.has(poolId) ? (
                            <p className="text-xs text-amber-400">
                                Widen that pool&apos;s scope to include this repository under Apps &gt; Runners, or its
                                jobs will queue forever.
                            </p>
                        ) : null}
                    </div>
                ) : (
                    <p className="text-xs text-amber-400">
                        You have no runner pools yet. Create one under Apps &gt; Runners, then pick it here.
                    </p>
                )
            ) : null}

            {/* Every blocker, not only the one on the current choice: somebody
                deciding between three options wants to know what each would need. */}
            {Object.entries(blocked)
                .filter(([execution]) => execution !== value)
                .map(([execution, reason]) => (
                    <p key={execution} className="text-xs text-muted-foreground">
                        <Badge variant="neutral" className="mr-1.5">
                            {AGENT_EXECUTION_LABELS[execution as AgentExecution]}
                        </Badge>
                        {reason} {fix(execution as AgentExecution)}
                    </p>
                ))}
        </div>
    );
}

/** What to do about a blocked execution. Every blocker has a fix, and naming it
 *  is the difference between a warning and a dead end. */
function fix(execution: AgentExecution): string {
    switch (execution) {
        case "actions":
            return "Give Polaris a public address under Settings > Domains.";
        case "runners":
            return "Add a pool under Apps > Runners, or point an existing one at this repository.";
        case "server":
            return "The container engine has to be reachable from Polaris; check Settings > System.";
    }
}
