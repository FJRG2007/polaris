"use client";

/**
 * A box per thing a connected app may do: the consent screen's list, and the
 * same list when somebody changes an app's permissions afterwards.
 *
 * Ticking a broad permission ticks what it cannot work without, locked, the
 * way the API key picker does; the server expands the same way whatever is
 * posted. Pure display: the caller holds what was ticked.
 */

import { Checkbox } from "@polaris/ui";
import { impliedBy } from "@polaris/core";
import type { Permission } from "@polaris/core";
import { scopeLabelKey } from "@/lib/mcp/oauth/scope-labels";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function McpScopeChecklist({
    offered,
    selected,
    effective,
    disabled,
    onToggle
}: {
    offered: readonly Permission[];
    /** What was ticked by hand. */
    selected: readonly Permission[];
    /** What the app would hold: the ticked ones and what they imply. */
    effective: ReadonlySet<Permission>;
    disabled?: boolean;
    onToggle: (scope: Permission, checked: boolean) => void;
}) {
    const t = useTranslations("mcp");
    return (
        <ul className="flex flex-col gap-1.5">
            {offered.map((scope) => {
                const implied = effective.has(scope) && !selected.includes(scope);
                const source = implied
                    ? selected.find((entry) => impliedBy(entry).includes(scope))
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
                            </span>
                        </label>
                    </li>
                );
            })}
        </ul>
    );
}
