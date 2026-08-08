"use client";

/**
 * Choosing what the rules on this page apply to.
 *
 * This used to be a flat list of every project and environment down the left, which
 * does not survive contact with a real instance: two projects with three environments
 * each is already nine entries before a single server or service appears, and the
 * list is the same length whether you came here for Polaris or for one container.
 *
 * So it works the way Deploy's header does instead, in the same place: the two
 * selects are portalled into the app bar beside the app switcher, because the scope
 * is what the whole screen is about rather than one control on it. The choice lives
 * in the URL, so a scope can be linked to, reloaded, and reached from a service's
 * own page.
 */

import { Select } from "@polaris/ui";
import { HeaderPortal } from "@/components/header-portal";
import { useRouter, useSearchParams } from "next/navigation";
import { SCOPE_KINDS, scopeNeedsTarget, scopeOptions, type ScopeCatalog, type ScopeKind } from "./scope-kinds";

export function ScopePicker({
    kind,
    id,
    catalog,
    canOperate
}: {
    kind: ScopeKind;
    id: string;
    catalog: ScopeCatalog;
    /** The two instance-wide scopes are operator controls, so a member is not offered
     *  them at all rather than being offered them and refused. */
    canOperate: boolean;
}) {
    const router = useRouter();
    const params = useSearchParams();
    const kinds = SCOPE_KINDS.filter(
        (entry) => canOperate || (entry.value !== "polaris" && entry.value !== "global")
        // Nothing installed from the marketplace means no shortcut to offer, and a
        // kind that resolves to an empty list is one that only wastes a click.
    ).filter((entry) => entry.value !== "marketplace" || catalog.marketplace.length > 0);
    const targets = scopeOptions(kind, catalog);

    function go(nextKind: ScopeKind, nextId: string) {
        const next = new URLSearchParams(params.toString());
        next.set("scope", nextKind);
        if (nextId) next.set("id", nextId);
        else next.delete("id");
        router.push(`/apps/firewall?${next.toString()}`);
    }

    const kindSelect = (
        <Select
            value={kind}
            aria-label="Scope"
            className="h-8 min-w-0 flex-1 font-medium md:w-40 md:min-w-[10rem] md:flex-none"
            options={kinds.map((entry) => ({ value: entry.value, label: entry.label }))}
            onValueChange={(value) => {
                const nextKind = value as ScopeKind;
                // Moving to a kind that names something lands on its first entry, so the
                // page is never showing a chooser with nothing chosen.
                const first = scopeNeedsTarget(nextKind) ? (scopeOptions(nextKind, catalog)[0]?.id ?? "") : "";
                go(nextKind, first);
            }}
        />
    );

    const targetSelect = !scopeNeedsTarget(kind) ? null : targets.length > 0 ? (
        <Select
            value={id || (targets[0]?.id ?? "")}
            aria-label="Scope target"
            className="h-8 min-w-0 flex-1 md:w-60 md:min-w-[15rem] md:flex-none"
            options={targets.map((target) => ({ value: target.id, label: target.label }))}
            onValueChange={(value) => go(kind, value)}
        />
    ) : (
        <span className="whitespace-nowrap text-sm text-muted-foreground">Nothing of that kind yet.</span>
    );

    return (
        <>
            {/* In the top bar where there is room beside the app switcher, and at the
                top of the page where there is not - the same controls, never both. */}
            <HeaderPortal>
                <span className="hidden text-muted-foreground/40 md:inline">/</span>
                <span className="hidden items-center gap-2 md:flex">
                    {kindSelect}
                    {targetSelect ? <span className="text-muted-foreground/40">/</span> : null}
                    {targetSelect}
                </span>
            </HeaderPortal>

            <div className="flex items-center gap-2 md:hidden">
                {kindSelect}
                {targetSelect}
            </div>
        </>
    );
}
