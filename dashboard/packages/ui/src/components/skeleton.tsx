/**
 * Skeleton placeholder. A pulsing block used to reserve layout while data loads,
 * so a slow fetch shows structure instead of a blank area or a spinner. Compose
 * several to sketch the shape of the content that is coming.
 */

import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("animate-pulse rounded-md bg-muted", className)} {...props} />;
}
