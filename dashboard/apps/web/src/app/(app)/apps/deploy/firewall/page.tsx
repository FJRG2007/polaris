/**
 * Instance-wide firewall (/apps/deploy/firewall). Two scopes nobody owns: Polaris's
 * own ingress and every deployed service on the instance. Both are operator controls,
 * so this page needs `system.manage` rather than the `deploy.manage` a member holds.
 */

import { clientIp } from "@/lib/request-context";
import { requirePermission } from "@/lib/session";
import { FirewallView, type FirewallScope } from "../firewall-view";

export const dynamic = "force-dynamic";

const SCOPES: FirewallScope[] = [
    {
        type: "polaris",
        id: "",
        label: "Polaris",
        // Require-login is not offered: the dashboard has a login of its own, and the
        // guard's cross-domain handoff in front of it would be a loop.
        offerLogin: false,
        description:
            "Guards the dashboard itself on the public domains it answers on. The local network name is served separately and stays reachable, so shutting the public internet out here is something you can undo from your own network."
    },
    {
        type: "global",
        id: "",
        label: "All services",
        description:
            "Applies to every deployed service across all projects. A project or a service can add further restrictions on top, never loosen these."
    }
];

export default async function FirewallPage() {
    await requirePermission("system.manage");
    return (
        <FirewallView
            title="Firewall"
            backHref="/apps/deploy"
            backLabel="Projects"
            scopes={SCOPES}
            callerIp={(await clientIp()) ?? null}
        />
    );
}
