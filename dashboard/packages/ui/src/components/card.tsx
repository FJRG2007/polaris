/** Surface container primitives. Composed as Card > CardHeader/CardBody. */

import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn.js";

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div
            className={cn("rounded-lg border border-border bg-card shadow-sm", className)}
            {...props}
        />
    );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("flex flex-col gap-1 border-b border-border p-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    return <h3 className={cn("text-sm font-semibold tracking-tight", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("p-4", className)} {...props} />;
}
