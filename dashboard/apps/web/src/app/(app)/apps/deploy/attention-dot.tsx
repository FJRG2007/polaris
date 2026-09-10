/**
 * The dot a tab or a section wears when something behind it needs a look. The
 * reason is its accessible name and its tooltip, so the dot never has to be
 * decoded from its colour.
 */

import { cn } from "@polaris/ui";
import type { ServiceAttention } from "@/lib/deploy/attention";

export function TabAttentionDot({ label, className }: { label: string; className?: string }) {
    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            className={cn("inline-block size-1.5 shrink-0 rounded-full bg-danger-solid", className)}
        />
    );
}

/** Which of a service's tabs has something to show for it, and what. */
export function tabAttention(attention: ServiceAttention | null | undefined): Partial<Record<string, string>> {
    if (!attention) return {};
    return {
        ...(attention.deployFailed ? { Deployments: "The last deploy failed" } : {}),
        ...(attention.domainDown ? { Settings: "An address is down" } : {}),
        ...(attention.cronFailing ? { Cron: "A scheduled job is failing" } : {})
    };
}
