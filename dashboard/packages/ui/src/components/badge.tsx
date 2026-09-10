/** Small status pill used for edition, capability, and share-state labels. */

import { cn } from "../lib/cn";
import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

// A squared-off tag rather than a pill: it sits in tables and beside titles next
// to square-cornered controls, and a capsule among them reads as a sticker. The
// status variants are drawn from the per-theme chip tokens (tokens.css), so the
// tint and the ink inside it are right on a white card and a dark one alike.
const badgeVariants = cva(
    "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[0.6875rem] font-medium leading-[18px]",
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
    extends HTMLAttributes<HTMLSpanElement>,
        VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
    return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** The class list of a status chip, for the few places that are not a Badge - a
 *  link, a button - but must look like one. */
export function statusChipClass(tone: "success" | "warning" | "danger" | "neutral"): string {
    return badgeVariants({ variant: tone });
}
