"use client";

/**
 * A switch that sits in a table's toolbar, beside the search box.
 *
 * For the one setting that decides what the table underneath it means. On a
 * players screen that is whether the join list is enforced at all - a list nobody
 * is checked against is the commonest way to think you are private and not be -
 * and it belongs above the list rather than on a settings screen somewhere else,
 * where somebody reading the list would never see it.
 *
 * Its own component because every game's players table needs the same one, and
 * the two that had it had drifted into different heights and different ways of
 * saying which way round it was.
 */

import { Switch, cn } from "@polaris/ui";

export function ToolbarSwitch({
    label,
    checked,
    disabled,
    onChange,
    className
}: {
    /** What it says when it is on and when it is off. Read out as the switch's
     *  own name too, so it is never just "on". */
    label: { on: string; off: string };
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
    className?: string;
}) {
    return (
        <div className={cn("flex h-10 items-center gap-2 rounded-md border border-border px-3", className)}>
            <span className="whitespace-nowrap text-xs text-muted-foreground">{checked ? label.on : label.off}</span>
            <Switch checked={checked} disabled={disabled} aria-label={label.on} onChange={onChange} />
        </div>
    );
}
