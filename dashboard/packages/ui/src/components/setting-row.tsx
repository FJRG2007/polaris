/**
 * One setting: what it is called, a line saying what it changes, and the
 * control beside them - or under them when the screen is too narrow for both,
 * so neither the words nor the control is ever cut.
 *
 * The type scale is the interface's own (docs/design.md, "Type"): the name at
 * 13px like every row, field and button, the hint under it at 11px in the
 * subtle step. Settings screens drew this by hand in three sizes - 14px names
 * with 14px hints, 14px with 12px, 13px with 11px - side by side on one page.
 * `settingType` is the same scale for the few lines that are not a row (a
 * card's own explanation, a status line), so nothing on a settings screen
 * needs a size of its own.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";

export const settingType = {
    /** The setting's name. */
    title: "text-[0.8125rem] text-foreground",
    /** What it changes, under the name; also a card's own explanation. */
    hint: "text-[0.6875rem] leading-snug text-foreground-subtle",
    /** Why the last change did not take. */
    error: "text-[0.6875rem] leading-snug text-danger",
    /** Any other line on the screen - a field's label, a list row, a notice, an
     *  empty state - at the row's 13px. Size only: the site sets the colour. */
    body: "text-[0.8125rem]",
    /** A secondary line that is not a hint - a status, a count, a badge, a
     *  timestamp - at the scale's 11px. Size only: the site sets the colour. */
    small: "text-[0.6875rem] leading-snug"
} as const;

export function SettingRow({
    id,
    icon,
    label,
    hint,
    error,
    className,
    children
}: {
    /** Prefix for the label's and hint's ids, so the control can point at them
     *  with `aria-labelledby={`${id}-label`}` and `aria-describedby={`${id}-hint`}`. */
    id: string;
    /** Leading icon, for a row that is a card of its own. */
    icon?: ReactNode;
    label: ReactNode;
    hint?: ReactNode;
    /** Shown under the hint, announced as an alert. */
    error?: ReactNode;
    className?: string;
    /** The control. */
    children?: ReactNode;
}) {
    return (
        <div className={cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", className)}>
            {icon ? <span className="flex shrink-0 text-muted-foreground [&>svg]:size-4">{icon}</span> : null}
            <div className="flex min-w-0 flex-[1_1_14rem] flex-col">
                <span id={`${id}-label`} className={cn("break-words", settingType.title)}>
                    {label}
                </span>
                {hint ? (
                    <span id={`${id}-hint`} className={cn("break-words", settingType.hint)}>
                        {hint}
                    </span>
                ) : null}
                {error ? (
                    <span role="alert" className={settingType.error}>
                        {error}
                    </span>
                ) : null}
            </div>
            {children ? <div className="flex max-w-full shrink-0 items-center">{children}</div> : null}
        </div>
    );
}
