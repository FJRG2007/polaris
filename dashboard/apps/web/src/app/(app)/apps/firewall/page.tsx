/**
 * The firewall (/apps/firewall).
 *
 * Structured the way a firewall is actually used, which is the way Cloudflare
 * structures one: pick what the rules apply to at the top, then work down through the
 * rules themselves. The scope lives in the URL (`?scope=project&id=...`), so a
 * service's own page can link straight at its rules and a reload lands back where it
 * was.
 *
 * A scope is anything a rule can sensibly be attached to: Polaris's own ingress, every
 * deployed service at once, a group of servers, one server, a project, an environment,
 * or a single service. They merge broadest-first, so a narrower scope can restrict
 * further and never loosen.
 */

import { notFound } from "next/navigation";
import { listHosts } from "@/lib/host-service";
import { clientIp } from "@/lib/request-context";
import { FirewallScopeEditor } from "./scope-editor";
import { listProjectScopes } from "@/lib/deploy-service";
import { listHostGroups } from "@/lib/host-group-service";
import { FirewallInstancePanels } from "./instance-panels";
import { requirePermission, userHasManage } from "@/lib/session";
import { WAF_SCOPE_TYPES, type WafScopeType } from "@polaris/core";
import { ScopePicker } from "./scope-picker";
import { scopeNeedsTarget, scopeOptions, type ScopeCatalog, type ScopeOption } from "./scope-kinds";

export const dynamic = "force-dynamic";

/** What each scope covers, said once here rather than repeated in the editor. */
function describe(kind: WafScopeType, label: string): string {
    switch (kind) {
        case "polaris":
            return "Guards the dashboard itself on the public domains it answers on. The local network name is served separately and stays reachable, so shutting the public internet out here is something you can undo from your own network.";
        case "global":
            return "Applies to every deployed service across all projects. Anything narrower can add restrictions on top, never loosen these.";
        case "server-group":
            return `Applies to every service running on any server in ${label}. Adding a server to the group brings it under these rules.`;
        case "server":
            return `Applies to every service running on ${label}, whichever project it belongs to.`;
        case "project":
            return `Applies to every service in ${label}, in every environment.`;
        case "environment":
            return `Applies to every service in ${label}.`;
        case "application":
            return `Applies to ${label} alone.`;
    }
}

export default async function FirewallPage({
    searchParams
}: {
    searchParams: Promise<{ scope?: string; id?: string }>;
}) {
    const { scope, id } = await searchParams;
    const user = await requirePermission("deploy.manage");
    const canOperate = await userHasManage(user, "system.manage");

    const [projects, hosts, groups] = await Promise.all([
        listProjectScopes(user.id),
        listHosts(user.id),
        listHostGroups(user.id)
    ]);

    const environments: ScopeOption[] = [];
    const services: ScopeOption[] = [];
    for (const project of projects) {
        for (const environment of project.environments) {
            environments.push({ id: environment.id, label: `${project.name} / ${environment.name}` });
            for (const application of environment.applications) {
                services.push({ id: application.id, label: `${project.name} / ${environment.name} / ${application.name}` });
            }
        }
    }
    const catalog: ScopeCatalog = {
        projects: projects.map((project) => ({ id: project.id, label: project.name })),
        environments,
        services,
        servers: hosts.map((host) => ({ id: host.id, label: host.name })),
        serverGroups: groups.map((group) => ({ id: group.id, label: group.name }))
    };

    // An unknown scope in the URL is a typo or a stale link, not a 404: fall back to
    // the widest thing this caller is allowed to see.
    const requested = WAF_SCOPE_TYPES.includes(scope as WafScopeType) ? (scope as WafScopeType) : null;
    const fallback: WafScopeType = canOperate ? "polaris" : "project";
    let kind = requested ?? fallback;
    if (!canOperate && (kind === "polaris" || kind === "global")) kind = "project";

    const options = scopeOptions(kind, catalog);
    const scopeId = scopeNeedsTarget(kind) ? (options.find((option) => option.id === id)?.id ?? options[0]?.id ?? "") : "";
    if (scopeNeedsTarget(kind) && id && !options.some((option) => option.id === id)) {
        // An id that is not the caller's must not silently resolve to their first
        // project - that would be a link to someone else's rules quietly rewritten
        // into a link to their own.
        notFound();
    }
    const label = options.find((option) => option.id === scopeId)?.label ?? "";

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <div className="flex flex-col gap-3">
                <h1 className="text-2xl font-semibold">Firewall</h1>
                <ScopePicker kind={kind} id={scopeId} catalog={catalog} canOperate={canOperate} />
            </div>

            {scopeNeedsTarget(kind) && !scopeId ? (
                <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    Nothing of that kind exists yet, so there is nothing to protect. Create one and its rules appear
                    here.
                </p>
            ) : (
                <FirewallScopeEditor
                    key={`${kind}:${scopeId}`}
                    scopeType={kind}
                    scopeId={scopeId}
                    description={describe(kind, label)}
                    // Polaris has a login of its own; sending its visitors round the
                    // guard's cross-domain handoff to reach it would be a loop.
                    offerLogin={kind !== "polaris"}
                    callerIp={(await clientIp()) ?? null}
                />
            )}

            {/* Traffic, bans, jails and intelligence feeds are instance-wide however
                narrow the scope above happens to be, so they are shown to whoever runs
                the instance rather than to a project's members. */}
            {canOperate ? <FirewallInstancePanels /> : null}
        </div>
    );
}

