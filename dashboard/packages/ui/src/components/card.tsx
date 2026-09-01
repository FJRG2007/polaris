/** Surface container primitives. Composed as Card > CardHeader/CardBody. */

import { cn } from "../lib/cn";
import type { HTMLAttributes } from "react";

/** A card is one step up from the surface it sits on, and its edge is what says
 *  so - not a drop shadow. Shadows are kept for the things that genuinely float
 *  above the page (popovers, modals), so that when one appears it means
 *  something. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return (
        <div className={cn("flex flex-col gap-0.5 border-b border-border px-4 py-3", className)} {...props} />
    );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
    return <h3 className={cn("text-[0.8125rem] font-semibold tracking-tight", className)} {...props} />;
}

export function CardBody({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
    return <div className={cn("p-4", className)} {...props} />;
}
