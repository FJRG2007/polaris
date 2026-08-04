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
 * The recommendation is shown as a reason, not as a lock. An option Polaris
 * cannot offer at all is disabled and says why, because those would not fail at
 * the form but half an hour later inside a job.
 */
export function ExecutionPicker({
    value,
    advice,
    pools,
    poolId,
    onChange,
    onPoolChange
}: {
    value: AgentExecution;
    advice: ExecutionAdvice | null;
    pools: Array<{ id: string; name: string }>;
    poolId: string | null;
    onChange: (next: AgentExecution) => void;
    onPoolChange: (next: string | null) => void;
}) {
    const blocked = advice?.unavailable ?? {};

    return (
        <div className="space-y-2">
            <label className="text-sm font-medium">Runs on</label>
            <Select
                value={value}
                onValueChange={(next) => onChange(next as AgentExecution)}
                options={AGENT_EXECUTIONS.map((execution) => ({
                    value: execution,
                    label: AGENT_EXECUTION_LABELS[execution],
                    disabled: Boolean(blocked[execution])
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

            {blocked[value] ? <p className="text-xs text-amber-400">{blocked[value]}</p> : null}

            {value === "runners" ? (
                pools.length > 0 ? (
                    <div className="space-y-1 pt-2">
                        <label className="text-sm font-medium">Runner pool</label>
                        <Select
                            value={poolId ?? ""}
                            onValueChange={(next) => onPoolChange(next || null)}
                            options={pools.map((pool) => ({ value: pool.id, label: pool.name }))}
                        />
                    </div>
                ) : (
                    <p className="text-xs text-amber-400">{blocked.runners}</p>
                )
            ) : null}

            {/* Every blocker, not only the one on the current choice: somebody
                deciding between three options wants to know why two are greyed. */}
            {Object.entries(blocked)
                .filter(([execution]) => execution !== value)
                .map(([execution, reason]) => (
                    <p key={execution} className="text-xs text-muted-foreground">
                        <Badge variant="neutral" className="mr-1.5">
                            {AGENT_EXECUTION_LABELS[execution as AgentExecution]}
                        </Badge>
                        {reason}
                    </p>
                ))}
        </div>
    );
}
