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

import { WafEditor } from "./waf-editor";
import { notFound } from "next/navigation";
import { ScopePicker } from "./scope-picker";
import { clientIp } from "@/lib/request-context";
import { FirewallInstancePanels } from "./instance-panels";
import { requirePermission, userHasManage } from "@/lib/session";
import { WAF_SCOPE_TYPES, type WafScopeType } from "@polaris/core";
import { firewallSlot } from "@/lib/app-extensions/registry";
import * as scopeOptions from "@/lib/firewall-scope-options";
import { AppSlotView } from "@/components/app-extensions/installed-client";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceTranslator } from "@/lib/i18n/types";
import { ruleScopeFor, scopeNeedsTarget, type ScopeKind } from "./scope-kinds";

export const dynamic = "force-dynamic";

/** What each scope covers, said once here rather than repeated in the editor. */
function describe(kind: ScopeKind, label: string, t: NamespaceTranslator<"firewall">): string {
    switch (kind) {
        case "marketplace":
            return t("describe.marketplace", { label });
        case "polaris":
            return t("describe.polaris");
        case "global":
            return t("describe.global");
        case "server-group":
            return t("describe.serverGroup", { label });
        case "server":
            return t("describe.server", { label });
        case "project":
            return t("describe.project", { label });
        case "environment":
            return t("describe.environment", { label });
        case "application":
            return t("describe.application", { label });
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
    const t = await getTranslations("firewall");

    // An unknown scope in the URL is a typo or a stale link, not a 404: fall back to
    // the widest thing this caller is allowed to see.
    //
    // "All services" rather than "Polaris itself", even though the dashboard's own
    // scope is the broader-sounding of the two. Someone opening the firewall came to
    // protect what they deployed; the dashboard is one application among those, and its
    // own scope is a special case they can pick when they want it.
    const known = (value: string | undefined): value is ScopeKind =>
        value === "marketplace" || WAF_SCOPE_TYPES.includes(value as WafScopeType);
    const fallback: ScopeKind = canOperate ? "global" : "project";
    let kind: ScopeKind = known(scope) ? scope : fallback;
    if (!canOperate && (kind === "polaris" || kind === "global")) kind = "project";
    // The marketplace shortcut is a way of naming a service, so it resolves to one:
    // rules written here are the same rows the Service scope would show.
    const ruleScope = ruleScopeFor(kind);

    // Only the one target in the URL - or the first one, when it names none - is read
    // here; the picker pages the rest from the server as somebody scrolls.
    const [resolved, marketplace] = await Promise.all([
        kind === "polaris" || kind === "global"
            ? null
            : scopeOptions.resolveFirewallScope(user.id, kind, id),
        // Nothing installed from the marketplace means no shortcut to offer.
        kind === "marketplace"
            ? null
            : scopeOptions.resolveFirewallScope(user.id, "marketplace", undefined)
    ]);
    // An id that is not the caller's must not silently resolve to their first
    // project - that would be a link to someone else's rules quietly rewritten
    // into a link to their own.
    if (resolved?.refused) notFound();
    const chosen = resolved?.option ?? null;
    const scopeId = chosen?.id ?? "";
    const label = chosen ? scopeOptions.firewallScopeLabel(chosen) : "";
    const offerMarketplace = kind === "marketplace" || Boolean(marketplace?.option);
    // A service an installed app runs may be guarded by something else entirely -
    // a game server by its player list, not the HTTP rules below. Asked only when
    // one service is in scope, which is the only case where it can be one.
    const appSection =
        ruleScope === "application" && scopeId
            ? await firewallSlot(user.id, scopeId).catch(() => null)
            : null;
    // Read once: the editor offers it for the allowlist, and the anomaly panel marks
    // the reader's own address so a finding about themselves reads as one.
    const callerIp = (await clientIp()) ?? null;

    return (
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-5">
            <div className="flex flex-col gap-3">
                <div className="flex min-w-0 items-baseline gap-2">
                    <h1 className="text-[1.0625rem] font-semibold tracking-tight">
                        {t("page.title")}
                    </h1>
                    {/* The selects live in the app bar on a wide screen, where the
                        chosen scope is no longer next to the title - so the title
                        carries it. */}
                    {label ? (
                        <span
                            className="hidden min-w-0 truncate text-sm text-muted-foreground md:inline"
                            title={label}
                        >
                            {label}
                        </span>
                    ) : null}
                </div>
                <ScopePicker
                    kind={kind}
                    id={scopeId}
                    label={label}
                    offerMarketplace={offerMarketplace}
                    canOperate={canOperate}
                />
            </div>

            {scopeNeedsTarget(kind) && !scopeId ? (
                <p className="rounded-md border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                    {t("page.nothing")}
                </p>
            ) : (
                <>
                    {appSection && <AppSlotView slot={appSection} />}
                    <WafEditor
                        key={`${ruleScope}:${scopeId}`}
                        scopeType={ruleScope}
                        scopeId={scopeId}
                        description={describe(kind, label, t)}
                        // Polaris has a login of its own; sending its visitors round the
                        // guard's cross-domain handoff to reach it would be a loop.
                        offerLogin={kind !== "polaris"}
                        callerIp={callerIp}
                        canOperate={canOperate}
                        // Traffic, bans and jails are instance-wide however narrow the
                        // scope above happens to be, so they are shown to whoever runs
                        // the instance rather than to a project's members. Handed to the
                        // editor rather than rendered beside it: they belong under the
                        // rule LIST, and a rule opened from it is a page of its own.
                        instancePanels={
                            canOperate ? <FirewallInstancePanels callerIp={callerIp} /> : null
                        }
                    />
                </>
            )}
        </div>
    );
}
