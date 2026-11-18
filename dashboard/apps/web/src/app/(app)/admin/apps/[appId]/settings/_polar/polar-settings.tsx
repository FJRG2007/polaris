/**
 * Polar's administrator settings, drawn by Polaris apps > Polar > Settings.
 * The caller has already checked that the reader is an administrator.
 *
 * Two regions, each streamed on its own: what Polar's chats may reach and their
 * default routing, then Polar Code's sessions.
 */

import { sharedWorkspaceAllowed } from "@/lib/agents/session-capacity";
import { polarChatAdmin, polarCodeAdmin } from "./data";
import { PolarCodeView } from "./polar-code-view";
import { RoutingCard } from "./routing-card";
import { PolarOptionsCard } from "./polar-options-card";
import { SharedWorkspaceCard } from "./shared-machine-card";

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
