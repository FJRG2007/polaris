/** Small status pill used for edition, capability, and share-state labels. */

import { cn } from "../lib/cn";
import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

// A squared-off tag rather than a pill: it sits in tables and beside titles next
// to square-cornered controls, and a capsule among them reads as a sticker. The
// status variants are drawn from the per-theme chip tokens (tokens.css), so the
// tint and the ink inside it are right on a white card and a dark one alike.
// A label never breaks inside itself and never gives up width to a neighbour: a
// badge squeezed into "Time / out" or a sliver beside a long title reads as a bug.
const badgeVariants = cva(
    "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded border px-1.5 py-px text-[0.6875rem] font-medium leading-[18px]",
    {
        variants: {
            variant: {
                neutral: "border-border bg-muted text-muted-foreground",
                primary: "border-transparent bg-primary/15 text-primary",
                success: "border-success-edge bg-success-soft text-success-ink",
                warning: "border-warning-edge bg-warning-soft text-warning-ink",
                danger: "border-danger-edge bg-danger-soft text-danger-ink"
            }
        },
        defaultVariants: { variant: "neutral" }
    }
);

export interface BadgeProps
    extends HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** The class list of a status chip, for the few places that are not a Badge - a
 *  link, a button - but must look like one. */
export function statusChipClass(tone: "success" | "warning" | "danger" | "neutral"): string {
    return badgeVariants({ variant: tone });
}

/** The badges of one table cell (or any narrow slot): one row while they fit,
 *  wrapping only past a cap.
 *
 *  A plain `flex flex-wrap` row is as narrow as its widest single badge, so in a
 *  table whose name column takes the leftover width (`w-full max-w-0`) the
 *  browser hands the badge column exactly that and the badges stack one per
 *  line, four lines a row, beside a column that is mostly empty. `w-max` makes
 *  the whole row the column's floor instead, and the cap - `min(20rem, 40vw)` -
 *  is where it starts wrapping. Below `sm` there is no width to hand out, so a
 *  phone wraps them as it must rather than pushing the table sideways. */
export function TagList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn(
                "flex flex-wrap items-center gap-1 sm:w-max sm:max-w-[min(20rem,40vw)]",
                className
            )}
            {...props}
        />
    );
}
