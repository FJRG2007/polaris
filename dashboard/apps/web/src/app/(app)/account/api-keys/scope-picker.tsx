"use client";

/**
 * Choosing what a key may do, at a size that keeps growing.
 *
 * There are thirty-five permissions today and there will be a hundred: every app
 * Polaris grows adds two or three, and a flat checklist of a hundred boxes is a
 * form nobody reads - people tick the broadest thing they recognise and move on,
 * which is exactly how keys end up carrying half an account.
 *
 * So the list behaves like a list rather than like a form. It opens closed, one
 * row per area with a count beside it, and only what somebody actually opens is
 * on screen. A search box narrows to matching permissions across every area at
 * once and opens the areas that matched, which is how somebody who knows they
 * want "deploy" gets there without scrolling. What has been chosen is drawn as
 * chips at the top, so the answer to "what does this key carry" is one line and
 * never a scroll back through the sections.
 *
 * Picking a broad permission ticks the narrower ones it cannot work without -
 * writing files you cannot read back is not a real grant - and those stay ticked
 * and locked while the broader one is held, so the list always shows what the key
 * will actually carry rather than what was clicked.
 *
 * Only scopes the owner holds are offered; the server re-checks that anyway.
 */

import { useMemo, useState } from "react";
import { ChevronRight, Search, X } from "lucide-react";
import { Badge, Button, Checkbox, Input, cn } from "@polaris/ui";
import { expandPermissions, impliedBy, type Permission } from "@polaris/core";
import { SCOPE_GROUPS, SCOPE_HINTS, SCOPE_LABELS } from "@/lib/api-key-scopes";

/** Which held scope pulled an implied one in, for the "Included with" note. */
function includedBy(scope: Permission, selected: readonly Permission[]): Permission | null {
    return selected.find((entry) => entry !== scope && impliedBy(entry).includes(scope)) ?? null;
}

/** Whether a permission answers what was typed. The name people search by is the
 *  label, but the scope itself is what appears in documentation and in a token's
 *  own error messages, so both count. */
function matches(scope: Permission, needle: string): boolean {
    if (!needle) return true;
    return `${scope} ${SCOPE_LABELS[scope]} ${SCOPE_HINTS[scope]}`.toLowerCase().includes(needle);
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
    const [search, setSearch] = useState("");
    /** Which areas the reader has opened. Closed is the default: the point of
     *  the sections is that a hundred permissions are not on screen at once. */
    const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

    const offered = useMemo(() => new Set(available), [available]);
    const groups = useMemo(() => {
        const named = SCOPE_GROUPS.map((group) => ({
            title: group.title,
            scopes: group.scopes.filter((scope) => offered.has(scope))
        })).filter((group) => group.scopes.length > 0);
        const listed = new Set(named.flatMap((group) => group.scopes));
        const rest = available.filter((scope) => !listed.has(scope));
        return rest.length > 0 ? [...named, { title: "Other", scopes: rest }] : named;
    }, [available, offered]);

    const needle = search.trim().toLowerCase();
    const effective = useMemo(() => new Set(expandPermissions(selected)), [selected]);

    function toggle(scope: Permission, checked: boolean) {
        onChange(checked ? [...selected, scope] : selected.filter((entry) => entry !== scope));
    }

    if (available.length === 0) {
        return (
            <p className="text-sm text-muted-foreground">
                You hold no permissions a key could carry.
            </p>
        );
    }

    return (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <span className="relative min-w-[12rem] flex-1">
                    <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                        placeholder="Filter permissions"
                        aria-label="Filter permissions"
                        autoComplete="off"
                        className="pl-8"
                    />
                </span>
                <span className="text-xs text-muted-foreground">
                    {effective.size} of {available.length} selected
                </span>
            </div>

            {/* What the key will carry, in one line. The chips are the answer to
                the only question this section is really asked, and each one is
                the way to take a permission back off without finding its row
                again. Implied permissions are shown but not removable: they go
                when the one that pulled them in goes. */}
            {effective.size > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {[...effective].map((scope) => {
                        const source = includedBy(scope, selected);
                        return source ? (
                            <Badge key={scope} variant="neutral" title={`Included with ${SCOPE_LABELS[source]}`}>
                                {SCOPE_LABELS[scope]}
                            </Badge>
                        ) : (
                            <button
                                key={scope}
                                type="button"
                                onClick={() => toggle(scope, false)}
                                aria-label={`Remove ${SCOPE_LABELS[scope]}`}
                                title={`Remove ${SCOPE_LABELS[scope]}`}
                                className="inline-flex items-center gap-1 rounded border border-transparent bg-primary/15 px-1.5 py-px text-[11px] font-medium leading-[18px] text-primary transition-colors hover:bg-primary/25"
                            >
                                {SCOPE_LABELS[scope]}
                                <X className="size-3 shrink-0" />
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="flex flex-col rounded-md border border-border">
                {groups.map((group) => {
                    const shown = group.scopes.filter((scope) => matches(scope, needle));
                    if (shown.length === 0) return null;
                    // A search opens what it found: hiding matches behind a
                    // closed row would be a search that answers nothing.
                    const expanded = needle.length > 0 || open.has(group.title);
                    const chosen = group.scopes.filter((scope) => effective.has(scope)).length;

                    return (
                        <div key={group.title} className="border-b border-border last:border-b-0">
                            <button
                                type="button"
                                aria-expanded={expanded}
                                onClick={() =>
                                    setOpen((current) => {
                                        const next = new Set(current);
                                        if (next.has(group.title)) next.delete(group.title);
                                        else next.add(group.title);
                                        return next;
                                    })
                                }
                                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40"
                            >
                                <ChevronRight
                                    className={cn(
                                        "size-4 shrink-0 text-muted-foreground transition-transform duration-fast",
                                        expanded && "rotate-90"
                                    )}
                                />
                                <span className="min-w-0 flex-1 truncate font-medium">
                                    {group.title}
                                </span>
                                <span
                                    className={cn(
                                        "shrink-0 text-xs",
                                        chosen > 0 ? "text-primary" : "text-muted-foreground"
                                    )}
                                >
                                    {chosen > 0 ? `${chosen} of ${group.scopes.length}` : "None"}
                                </span>
                            </button>

                            {expanded && (
                                <div className="flex flex-col gap-2 px-3 pb-3 pl-9">
                                    {shown.map((scope) => {
                                        const source = includedBy(scope, selected);
                                        return (
                                            <label
                                                key={scope}
                                                className={cn(
                                                    "flex items-start gap-2 text-sm",
                                                    source ? "cursor-default" : "cursor-pointer"
                                                )}
                                            >
                                                <Checkbox
                                                    className="mt-0.5"
                                                    checked={effective.has(scope)}
                                                    disabled={source !== null}
                                                    onChange={(event) =>
                                                        toggle(scope, event.target.checked)
                                                    }
                                                />
                                                <span className="min-w-0">
                                                    <span className="flex flex-wrap items-center gap-x-2">
                                                        {SCOPE_LABELS[scope]}
                                                        <code className="text-[11px] text-muted-foreground">
                                                            {scope}
                                                        </code>
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
                            )}
                        </div>
                    );
                })}
                {groups.every((group) => group.scopes.every((scope) => !matches(scope, needle))) && (
                    <div className="flex items-center justify-between gap-2 px-3 py-3">
                        <p className="text-sm text-muted-foreground">
                            No permission matches that.
                        </p>
                        <Button size="sm" variant="ghost" onClick={() => setSearch("")}>
                            Clear
                        </Button>
                    </div>
                )}
            </div>
        </div>
    );
}
