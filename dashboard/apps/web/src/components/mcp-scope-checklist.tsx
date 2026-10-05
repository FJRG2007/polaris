"use client";

/**
 * A box per thing a connected app may do: the consent screen's list, and the
 * same list when somebody changes an app's permissions afterwards.
 *
 * Ticking a broad permission ticks what it cannot work without, locked, the
 * way the API key picker does; the server expands the same way whatever is
 * posted. A scope the app never asked for - one Polaris added since it
 * connected, say - is offered on the edit dialog with a line that says so,
 * and is never ticked for the person. Pure display: the caller holds what was
 * ticked.
 */

import { Checkbox } from "@polaris/ui";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { scopeImplies, type McpScope } from "@/lib/mcp/scope-table";

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
    return (
        <ul className="flex flex-col gap-1.5">
            {offered.map((scope) => {
                const implied = effective.has(scope) && !selected.includes(scope);
                const source = implied
                    ? selected.find((entry) => scopeImplies(entry).includes(scope))
                    : undefined;
                return (
                    <li key={scope}>
                        <label className="flex min-w-0 items-start gap-2">
                            <Checkbox
                                checked={effective.has(scope)}
                                disabled={implied || disabled}
                                onChange={(event) => onToggle(scope, event.target.checked)}
                                className="mt-0.5"
                            />
                            <span className="flex min-w-0 flex-col">
                                <span>{t(scopeLabelKey(scope))}</span>
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
    );
}
