"use client";

/**
 * A box per thing a connected app may do: the consent screen's list, and the
 * same list when somebody changes an app's permissions afterwards.
 *
 * The boxes are filed under their category (`groupByCategory`), one folding
 * section each with a count and a box of its own. The section's box ticks or
 * clears every scope in it that is not sensitive: a sensitive scope - sending
 * mail, unlocking a door - is only ever ticked by its own box, so allowing a
 * whole area never grants one without the person seeing it.
 *
 * Ticking a broad permission ticks what it cannot work without, locked, the
 * way the API key picker does; the server expands the same way whatever is
 * posted. A scope the app never asked for - one Polaris added since it
 * connected, say - is offered on the edit dialog with a line that says so,
 * and is never ticked for the person. Pure display: the caller holds what was
 * ticked.
 */

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Badge, Checkbox, cn } from "@polaris/ui";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    groupByCategory,
    isSensitiveScope,
    scopeImplies,
    type McpCategory,
    type McpScope
} from "@/lib/mcp/scope-table";

/** Up to this many sections, all start open: folding two headings hides more
 *  than it saves. Past it, a section starts open only when it holds a scope the
 *  app never asked for, so that note is never folded away. */
const OPEN_UP_TO = 2;

export function McpScopeChecklist({
    offered,
    selected,
    effective,
    unrequested,
    disabled,
    onToggle
}: {
    offered: readonly McpScope[];
    /** What was ticked by hand. */
    selected: readonly McpScope[];
    /** What the app would hold: the ticked ones and what they imply. */
    effective: ReadonlySet<McpScope>;
    /** The ones the app did not ask for, marked as such. */
    unrequested?: ReadonlySet<McpScope>;
    disabled?: boolean;
    onToggle: (scope: McpScope, checked: boolean) => void;
}) {
    const t = useTranslations("mcp");
    const groups = groupByCategory(offered);
    const [open, setOpen] = useState<ReadonlySet<McpCategory>>(
        () =>
            new Set(
                groups
                    .filter(
                        (group) =>
                            groups.length <= OPEN_UP_TO ||
                            group.scopes.some((scope) => unrequested?.has(scope))
                    )
                    .map((group) => group.category)
            )
    );

    function impliedSource(scope: McpScope): McpScope | undefined {
        if (!effective.has(scope) || selected.includes(scope)) return undefined;
        return selected.find((entry) => scopeImplies(entry).includes(scope));
    }

    return (
        <div className="flex flex-col rounded-md border border-border">
            {groups.map(({ category, scopes }) => {
                const label = t(`categories.${category}`);
                const expanded = open.has(category);
                const held = scopes.filter((scope) => effective.has(scope)).length;
                // What the section's box acts on: never a sensitive scope, and
                // never one that is only ticked because another implies it.
                const bulk = scopes.filter(
                    (scope) => !isSensitiveScope(scope) && impliedSource(scope) === undefined
                );
                const bulkHeld = bulk.filter((scope) => effective.has(scope)).length;
                const allHeld = bulk.length > 0 && bulkHeld === bulk.length;
                return (
                    <section key={category} className="border-b border-border last:border-b-0">
                        <div className="flex min-w-0 items-center gap-2 px-3 py-2">
                            <Checkbox
                                checked={allHeld}
                                indeterminate={!allHeld && held > 0}
                                disabled={disabled || bulk.length === 0}
                                aria-label={t("consent.groupAll", { category: label })}
                                title={t("consent.groupAll", { category: label })}
                                onChange={() => {
                                    for (const scope of bulk) {
                                        if (effective.has(scope) === !allHeld) continue;
                                        onToggle(scope, !allHeld);
                                    }
                                }}
                            />
                            <button
                                type="button"
                                aria-expanded={expanded}
                                aria-label={t("consent.groupShow", { category: label })}
                                onClick={() =>
                                    setOpen((current) => {
                                        const next = new Set(current);
                                        if (next.has(category)) next.delete(category);
                                        else next.add(category);
                                        return next;
                                    })
                                }
                                className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm"
                            >
                                <span className="min-w-0 flex-1 truncate font-medium" title={label}>
                                    {label}
                                </span>
                                <span
                                    className={cn(
                                        "shrink-0 text-xs",
                                        held > 0 ? "text-primary" : "text-muted-foreground"
                                    )}
                                >
                                    {t("consent.groupCount", { count: held, total: scopes.length })}
                                </span>
                                <ChevronRight
                                    aria-hidden
                                    className={cn(
                                        "size-4 shrink-0 text-muted-foreground transition-transform duration-fast",
                                        expanded && "rotate-90"
                                    )}
                                />
                            </button>
                        </div>
                        {expanded ? (
                            <ul className="flex flex-col gap-1.5 px-3 pb-3 pl-9">
                                {scopes.map((scope) => {
                                    const source = impliedSource(scope);
                                    return (
                                        <li key={scope}>
                                            <label className="flex min-w-0 items-start gap-2">
                                                <Checkbox
                                                    checked={effective.has(scope)}
                                                    disabled={source !== undefined || disabled}
                                                    onChange={(event) =>
                                                        onToggle(scope, event.target.checked)
                                                    }
                                                    className="mt-0.5"
                                                />
                                                <span className="flex min-w-0 flex-col">
                                                    <span className="flex flex-wrap items-center gap-x-2">
                                                        <span className="min-w-0 break-words">
                                                            {t(scopeLabelKey(scope))}
                                                        </span>
                                                        {isSensitiveScope(scope) ? (
                                                            <Badge
                                                                variant="warning"
                                                                title={t("consent.sensitiveHint")}
                                                            >
                                                                {t("consent.sensitive")}
                                                            </Badge>
                                                        ) : null}
                                                    </span>
                                                    <span className="truncate font-mono text-xs text-muted-foreground">
                                                        {source
                                                            ? t("consent.impliedBy", {
                                                                  scope: t(scopeLabelKey(source))
                                                              })
                                                            : scope}
                                                    </span>
                                                    {unrequested?.has(scope) ? (
                                                        <span className="text-xs text-muted-foreground">
                                                            {t("connectedApps.notRequested")}
                                                        </span>
                                                    ) : null}
                                                </span>
                                            </label>
                                        </li>
                                    );
                                })}
                            </ul>
                        ) : null}
                    </section>
                );
            })}
        </div>
    );
}
