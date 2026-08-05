"use client";

/**
 * The deployment's Agents defaults.
 *
 * One tier, and the only one nobody can inherit past: what it leaves on Inherit
 * falls to the built-in defaults in @polaris/core, which is what the card names.
 */

import { useState } from "react";
import { DEFAULT_AGENT_POLICY } from "@polaris/core";
import { AgentDefaultsCard } from "@/components/agent-defaults-card";
import { platformModelChoices, savePlatformAgentDefaultsAction } from "./actions";
import type { AgentDefaultsView } from "@/lib/agents/agent-defaults-service";

export function PlatformDefaultsView({
    platform,
    pools,
    providers
}: {
    platform: AgentDefaultsView;
    pools: Array<{ id: string; name: string }>;
    providers: string[];
}) {
    const [tier, setTier] = useState(platform);
    const [error, setError] = useState<string | null>(null);

    return (
        <div className="space-y-4">
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <AgentDefaultsCard
                tier={tier}
                title="Every repository on this deployment"
                inherited={DEFAULT_AGENT_POLICY}
                inheritedFrom="the built-in defaults"
                pools={pools}
                providers={providers}
                loadModels={platformModelChoices}
                save={savePlatformAgentDefaultsAction}
                onChange={setTier}
                onError={setError}
            />
        </div>
    );
}
