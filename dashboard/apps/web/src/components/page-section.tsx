/**
 * One titled part of a page, drawn as a section of it rather than as a card.
 *
 * A heading, an optional line under it, the controls that act on the whole
 * section, and whatever it holds - separated from the section before it by a
 * hairline rather than boxed. A page of settings stacked as cards is a column of
 * rectangles each competing for the eye; as sections it reads top to bottom.
 *
 * On a wide screen the heading sits beside what it heads, so a form uses the
 * page's width without stretching its fields across all of it. `wide` keeps the
 * heading above instead, for a table that needs every column it can get. Split
 * only from `xl`: the content area narrows at `md`, where the navigation rail
 * appears, and a heading column at `lg` would leave a form half a screen.
 */

import { cn } from "@polaris/ui";
import type { ReactNode } from "react";

export function PageSection({
    id,
    title,
    description,
    actions,
    wide = false,
    className,
    children
}: {
    id?: string;
    title: ReactNode;
    description?: ReactNode;
    /** Controls for the whole section, drawn under its heading. */
    actions?: ReactNode;
    /** Heading above the content rather than beside it. */
    wide?: boolean;
    className?: string;
    children?: ReactNode;
}) {
    return (
        <section
            id={id}
            className={cn(
                "scroll-mt-4 border-t border-border pt-6 first:border-t-0 first:pt-0",
                wide
                    ? "flex flex-col gap-3"
                    : "flex flex-col gap-3 xl:grid xl:grid-cols-[16rem_minmax(0,1fr)] xl:items-start xl:gap-x-10",
                className
            )}
        >
            <div
                className={cn(
                    "flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2",
                    !wide && "xl:flex-col xl:justify-start"
                )}
            >
                <div className="min-w-0">
                    <h2 className="flex items-center gap-2 text-[14px] font-semibold tracking-tight">{title}</h2>
                    {description ? (
                        <p className="mt-0.5 max-w-3xl text-[0.8125rem] text-muted-foreground">{description}</p>
                    ) : null}
                </div>
                {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
            </div>
            {/* Beside its heading a section is a form or prose, which reads badly
                stretched across a wide screen; a wide one is a table, which does not. */}
            <div className={cn("flex min-w-0 flex-col gap-4", !wide && "max-w-3xl")}>{children}</div>
        </section>
    );
}
