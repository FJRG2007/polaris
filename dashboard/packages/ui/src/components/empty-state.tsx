/**
 * The screen with nothing on it yet.
 *
 * Thirty-two screens drew their own version of this and four of them exported a
 * component called Empty or EmptyState, none of which agreed on the border, the
 * padding, or whether the icon sat in a circle. An empty screen is the first one
 * a new user sees, so it is worth having one of.
 *
 * `action` is not decoration. A screen that says "no servers yet" and offers no
 * way to add one has told somebody they are stuck; pass the button that gets
 * them out of it whenever there is one.
 */

import { cn } from "../lib/cn";
import type { ReactNode } from "react";

export function EmptyState({
    icon,
    title,
    description,
    action,
    /** Drops the dashed frame, for an empty state already inside a card or a
     *  panel that draws its own edge. */
    bare = false,
    className
}: {
    icon?: ReactNode;
    title: string;
    description?: string;
    action?: ReactNode;
    bare?: boolean;
    className?: string;
}) {
    return (
        <div
            className={cn(
                "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
                !bare && "rounded-lg border border-dashed border-border",
                className
            )}
        >
            {icon ? <span className="mb-1 text-foreground-subtle [&_svg]:size-6">{icon}</span> : null}
            <p className="text-[0.8125rem] font-medium text-foreground">{title}</p>
            {description ? (
                <p className="max-w-sm text-[0.8125rem] leading-relaxed text-muted-foreground">{description}</p>
            ) : null}
            {action ? <div className="mt-2 flex items-center gap-2">{action}</div> : null}
        </div>
    );
}
