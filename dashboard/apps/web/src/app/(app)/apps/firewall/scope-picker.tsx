"use client";

/**
 * Choosing what the rules on this page apply to.
 *
 * This used to be a flat list of every project and environment down the left, which
 * does not survive contact with a real instance: two projects with three environments
 * each is already nine entries before a single server or service appears, and the
 * list is the same length whether you came here for Polaris or for one container.
 *
 * So it works the way Deploy's header does instead - pick the kind of thing, then
 * pick which one - and the choice lives in the URL, so a scope can be linked to,
 * reloaded, and reached from a service's own page.
 */

import { Select } from "@polaris/ui";
import type { WafScopeType } from "@polaris/core";
import { useRouter, useSearchParams } from "next/navigation";
import { SCOPE_KINDS, scopeNeedsTarget, scopeOptions, type ScopeCatalog } from "./scope-kinds";

export function ScopePicker({
    kind,
    id,
    catalog,
    canOperate
}: {
    kind: WafScopeType;
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
    );
    const targets = scopeOptions(kind, catalog);

    function go(nextKind: WafScopeType, nextId: string) {
        const next = new URLSearchParams(params.toString());
        next.set("scope", nextKind);
        if (nextId) next.set("id", nextId);
        else next.delete("id");
        router.push(`/apps/firewall?${next.toString()}`);
    }

    return (
        <div className="flex flex-wrap items-center gap-2">
            <Select
                value={kind}
                aria-label="Scope"
                className="h-8 w-full font-medium sm:w-48"
                options={kinds.map((entry) => ({ value: entry.value, label: entry.label }))}
                onValueChange={(value) => {
                    const nextKind = value as WafScopeType;
                    // Moving to a kind that names something lands on its first entry,
                    // so the page is never showing a chooser with nothing chosen.
                    const first = scopeNeedsTarget(nextKind) ? (scopeOptions(nextKind, catalog)[0]?.id ?? "") : "";
                    go(nextKind, first);
                }}
            />
            {scopeNeedsTarget(kind) ? (
                targets.length > 0 ? (
                    <Select
                        value={id || (targets[0]?.id ?? "")}
                        aria-label="Scope target"
                        className="h-8 w-full sm:w-64"
                        options={targets.map((target) => ({ value: target.id, label: target.label }))}
                        onValueChange={(value) => go(kind, value)}
                    />
                ) : (
                    <p className="text-sm text-muted-foreground">Nothing of that kind yet.</p>
                )
            ) : null}
        </div>
    );
}
