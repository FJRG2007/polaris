"use client";

/**
 * The scope picker, grouped by resource. Picking a broad permission ticks the
 * narrower ones it cannot work without - writing files you cannot read back is
 * not a real grant - and those stay ticked and locked while the broader one is
 * held, so the list always shows what the key will actually carry rather than
 * what was clicked.
 *
 * Only scopes the owner holds are offered; the server re-checks that anyway.
 */

import { expandPermissions, impliedBy, type Permission } from "@polaris/core";
import { Checkbox } from "@polaris/ui";
import { SCOPE_GROUPS, SCOPE_HINTS, SCOPE_LABELS } from "@/lib/api-key-scopes";

/** Which held scope pulled an implied one in, for the "Included with" note. */
function includedBy(scope: Permission, selected: readonly Permission[]): Permission | null {
    return selected.find((entry) => entry !== scope && impliedBy(entry).includes(scope)) ?? null;
}

export function ScopePicker({
    available,
    selected,
    onChange
}: {
    available: readonly Permission[];
    /** Scopes ticked by hand. What the key carries is this, expanded. */
    selected: readonly Permission[];
    onChange: (scopes: Permission[]) => void;
}) {
    const offered = new Set(available);
    const grouped = SCOPE_GROUPS.map((group) => ({
        title: group.title,
        scopes: group.scopes.filter((scope) => offered.has(scope))
    })).filter((group) => group.scopes.length > 0);
    const listed = new Set(grouped.flatMap((group) => group.scopes));
    const rest = available.filter((scope) => !listed.has(scope));
    const groups = rest.length > 0 ? [...grouped, { title: "Other", scopes: rest }] : grouped;

    const effective = new Set(expandPermissions(selected));

    function toggle(scope: Permission, checked: boolean) {
        onChange(
            checked ? [...selected, scope] : selected.filter((entry) => entry !== scope)
        );
    }

    if (available.length === 0) {
        return <p className="text-sm text-muted-foreground">You hold no permissions a key could carry.</p>;
    }

    return (
        <div className="flex flex-col gap-3 rounded-md border border-border p-3">
            {groups.map((group) => (
                <div key={group.title} className="flex flex-col gap-2">
                    <p className="text-xs font-medium text-muted-foreground">{group.title}</p>
                    {group.scopes.map((scope) => {
                        const source = includedBy(scope, selected);
                        return (
                            <label
                                key={scope}
                                className={`flex items-start gap-2 text-sm ${source ? "cursor-default" : "cursor-pointer"}`}
                            >
                                <Checkbox
                                    className="mt-0.5"
                                    checked={effective.has(scope)}
                                    disabled={source !== null}
                                    onChange={(event) => toggle(scope, event.target.checked)}
                                />
                                <span className="min-w-0">
                                    <span className="flex flex-wrap items-center gap-x-2">
                                        {SCOPE_LABELS[scope]}
                                        {source ? (
                                            <span className="text-xs text-muted-foreground">
                                                Included with {SCOPE_LABELS[source]}
                                            </span>
                                        ) : null}
                                    </span>
                                    <span className="block text-xs text-muted-foreground">
                                        {SCOPE_HINTS[scope]}
                                    </span>
                                </span>
                            </label>
                        );
                    })}
                </div>
            ))}
        </div>
    );
}
