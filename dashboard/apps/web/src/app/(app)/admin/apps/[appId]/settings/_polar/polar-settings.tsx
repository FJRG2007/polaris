/**
 * Polar's administrator settings, drawn by Polaris apps > Polar > Settings.
 * The caller has already checked that the reader is an administrator.
 *
 * Three regions, each streamed on its own: what Polar's chats may reach and their
 * default routing, Polar Code's sessions, then the usage limits and agent
 * defaults every account and repository falls through to. The deployment's
 * provider keys are a screen of their own (`providers/providers-screen.tsx`).
 */

import { sharedWorkspaceAllowed } from "@/lib/agents/session-capacity";
import { polarChatAdmin, polarCodeAdmin } from "./data";
import { polarAgentAdmin } from "./agent-data";
import { PolarCodeView } from "./polar-code-view";
import { RoutingCard } from "./routing-card";
import { PolarOptionsCard } from "./polar-options-card";
import { SharedWorkspaceCard } from "./shared-machine-card";
import { UsageLimitsCard } from "./usage-limits-card";
import { PlatformDefaultsView } from "./platform-defaults-view";

export async function PolarAdminSettings() {
    const [code, sharedMachine] = await Promise.all([polarCodeAdmin(), sharedWorkspaceAllowed()]);
    return (
        <div className="space-y-4">
            <SharedWorkspaceCard allowed={sharedMachine} />
            <PolarCodeView initial={code} />
        </div>
    );
}

export async function PolarChatSettings() {
    const data = await polarChatAdmin();
    return (
        <div className="space-y-4">
            <PolarOptionsCard options={data.options} />
            <RoutingCard routing={data.routing} keys={data.routingKeys} />
        </div>
    );
}

/** The usage limits and the deployment's agent defaults. */
export async function PolarAgentSettings() {
    const data = await polarAgentAdmin();
    return (
        <div className="space-y-4">
            <UsageLimitsCard limits={data.limits} />
            <PlatformDefaultsView platform={data.platform} pools={data.pools} providers={data.providers} />
        </div>
    );
}
