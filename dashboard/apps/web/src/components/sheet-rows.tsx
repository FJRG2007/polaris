/**
 * The grouped rows a phone screen of choices is drawn with - the "You" sheet
 * and an app's own menu - the way Telegram and Signal lay out their settings:
 * rows a finger's height, in rounded groups under a small heading.
 */

import type { ReactNode } from "react";

/** One row's look, a link or a button alike: a finger's height, the icon
 *  fixed, the name the part that gives way. */
export const SHEET_ROW =
    "flex min-h-12 w-full min-w-0 items-center gap-3 px-3 py-2 text-start text-sm transition-colors duration-fast hover:bg-muted active:bg-muted [-webkit-tap-highlight-color:transparent]";

export function SheetGroup({ title, children }: { title?: string; children: ReactNode }) {
    return (
        <section className="flex min-w-0 flex-col gap-1.5">
            {title ? (
                <h2 className="truncate px-3 text-xs font-medium text-muted-foreground" title={title}>
                    {title}
                </h2>
            ) : null}
            <div className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-surface">{children}</div>
        </section>
    );
}

export function SheetRowLabel({ children }: { children: string }) {
    return (
        <span className="min-w-0 flex-1 truncate" title={children}>
            {children}
        </span>
    );
}
