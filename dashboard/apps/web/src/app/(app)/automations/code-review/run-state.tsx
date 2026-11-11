"use client";

import { Badge } from "@polaris/ui";
import type { AgentRunState } from "@polaris/core";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { agentWord } from "@/lib/agents/words";

/** How a run's state reads everywhere it is shown. One component so the run list,
 *  the overview and the run detail can never render the same state differently. */
export function RunState({ state }: { state: AgentRunState }) {
    const t = useTranslations("agents");
    const tone =
        state === "succeeded"
            ? "text-success"
            : state === "failed"
              ? "text-danger"
              : state === "cancelled"
                ? "text-muted-foreground"
                : "text-sky-400";
    return (
        <Badge variant="neutral" className={tone}>
            {agentWord(t, "runState", state)}
        </Badge>
    );
}
