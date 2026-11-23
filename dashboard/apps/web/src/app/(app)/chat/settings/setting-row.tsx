/**
 * One row of Chat settings: what the option is, a line saying what it changes,
 * and the control beside them - or under them when the screen is too narrow for
 * both, so neither the words nor the control is ever cut.
 */

import type { ReactNode } from "react";

export function SettingRow({
    id,
    label,
    hint,
    children
}: {
    /** Prefix for the hint's id, so the control can point at it with
     *  `aria-describedby={`${id}-hint`}`. */
    id: string;
    label: ReactNode;
    hint: ReactNode;
    /** The control. */
    children: ReactNode;
}) {
    return (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
                <span id={`${id}-label`} className="text-sm font-medium">
                    {label}
                </span>
                <span id={`${id}-hint`} className="text-sm text-muted-foreground">
                    {hint}
                </span>
            </div>
            <div className="flex max-w-full shrink-0 items-center">{children}</div>
        </div>
    );
}
