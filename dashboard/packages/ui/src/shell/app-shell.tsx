/**
 * The dashboard chrome: a slim top bar carrying the app switcher on the left and
 * account/edition controls on the right, an optional left navigation rail, and
 * the scrolling content area. Kept presentational and responsive - the rail
 * collapses on narrow viewports; callers supply the actual nav and account menu.
 */

import type { ReactNode } from "react";
import { cn } from "../lib/cn.js";

export function AppShell({
    switcher,
    account,
    sidebar,
    children
}: {
    switcher: ReactNode;
    account: ReactNode;
    sidebar?: ReactNode;
    children: ReactNode;
}) {
    return (
        <div className="flex min-h-screen flex-col bg-background">
            <header className="sticky top-0 z-40 flex h-14 shrink-0 items-center justify-between gap-4 border-b border-border bg-surface/80 px-4 backdrop-blur">
                <div className="flex items-center gap-3">
                    <PolarisMark />
                    {switcher}
                </div>
                <div className="flex items-center gap-2">{account}</div>
            </header>
            <div className="flex flex-1">
                {sidebar ? (
                    <aside className="hidden w-60 shrink-0 border-r border-border bg-surface/40 p-3 md:block">
                        {sidebar}
                    </aside>
                ) : null}
                <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
            </div>
        </div>
    );
}

/** The Polaris wordmark: a compact star glyph plus the name. */
export function PolarisMark({ className }: { className?: string }) {
    return (
        <span className={cn("flex items-center gap-2", className)}>
            <span className="grid size-7 place-items-center rounded-md bg-gradient-to-br from-primary to-accent text-primary-foreground">
                <svg viewBox="0 0 24 24" className="size-4" fill="currentColor" aria-hidden="true">
                    <path d="M12 2l1.9 6.6L20 10l-6.1 1.4L12 18l-1.9-6.6L4 10l6.1-1.4L12 2z" />
                </svg>
            </span>
            <span className="text-sm font-semibold tracking-tight">Polaris</span>
        </span>
    );
}

/** A page heading block for content areas. */
export function PageHeader({
    title,
    description,
    actions
}: {
    title: string;
    description?: string;
    actions?: ReactNode;
}) {
    return (
        <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                {description ? (
                    <p className="mt-1 text-sm text-muted-foreground">{description}</p>
                ) : null}
            </div>
            {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
        </div>
    );
}
