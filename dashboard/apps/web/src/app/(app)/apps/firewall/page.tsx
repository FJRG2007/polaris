/**
 * The firewall (/apps/firewall). Its own destination rather than a corner of Deploy:
 * the rules here reach the dashboard itself and every deployed service, which is not
 * something that belongs behind a project.
 *
 * Every scope an operator can edit is in one list, widest first - Polaris, all
 * services, then each project and its environments. The two instance-wide scopes are
 * operator controls, so they appear only with `system.manage`; a member with
 * `deploy.manage` still gets their own projects.
 */

import { clientIp } from "@/lib/request-context";
import { listProjectScopes } from "@/lib/deploy-service";
import { FirewallInstancePanels } from "./instance-panels";
import { requirePermission, userHasManage } from "@/lib/session";
import { FirewallView, type FirewallScope } from "./firewall-view";

export const dynamic = "force-dynamic";

const OPERATOR_SCOPES: FirewallScope[] = [
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
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");
    const projects = await listProjectScopes(user.id);

    const scopes: FirewallScope[] = [
        ...(canOperate ? OPERATOR_SCOPES : []),
        ...projects.flatMap((project): FirewallScope[] => [
            {
                type: "project",
                id: project.id,
                label: project.name,
                description: `Applies to every service in ${project.name}, in every environment. Stacks with each service's own rules.`
            },
            ...project.environments.map(
                (environment): FirewallScope => ({
                    type: "environment",
                    id: environment.id,
                    label: `${project.name} / ${environment.name}`,
                    description: `Applies to every service in the ${environment.name} environment of ${project.name}.`
                })
            )
        ])
    ];

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
            <FirewallView
                title="Firewall"
                intro="Who can reach what, enforced at the edge. Rules stack from the widest scope down, and a narrower one can only restrict further."
                scopes={scopes}
                callerIp={(await clientIp()) ?? null}
            />
            {/* Traffic, bans, jails and intelligence feeds are instance-wide, so they
                are shown to whoever runs the instance rather than to a project's
                members - who can still edit their own scopes above. */}
            {canOperate ? <FirewallInstancePanels /> : null}
        </div>
    );
}
