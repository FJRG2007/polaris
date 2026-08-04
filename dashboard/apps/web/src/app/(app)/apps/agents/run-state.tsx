"use client";

import { Badge } from "@polaris/ui";
import { AGENT_RUN_STATE_LABELS, type AgentRunState } from "@polaris/core";

/** How a run's state reads everywhere it is shown. One component so the run list,
 *  the overview and the run detail can never render the same state differently. */
export function RunState({ state }: { state: AgentRunState }) {
    const tone =
        state === "succeeded"
            ? "text-emerald-400"
            : state === "failed"
              ? "text-red-400"
              : state === "cancelled"
                ? "text-muted-foreground"
                : "text-sky-400";
    return (
        <Badge variant="neutral" className={tone}>
            {AGENT_RUN_STATE_LABELS[state]}
        </Badge>
    );
}
