/** Small status pill used for edition, capability, and share-state labels. */

import { cn } from "../lib/cn";
import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";

// A squared-off tag rather than a pill: it sits in tables and beside titles next
// to square-cornered controls, and a capsule among them reads as a sticker.
const badgeVariants = cva(
    "inline-flex items-center gap-1 rounded border px-1.5 py-px text-[11px] font-medium leading-[18px]",
    {
        variants: {
            variant: {
                neutral: "border-border bg-muted text-muted-foreground",
                primary: "border-transparent bg-primary/15 text-primary",
                success: "border-transparent bg-success/15 text-success",
                warning: "border-transparent bg-warning/15 text-warning",
                danger: "border-transparent bg-danger/15 text-danger"
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
