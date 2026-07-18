/** Small status pill used for edition, capability, and share-state labels. */

import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

const badgeVariants = cva(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
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
