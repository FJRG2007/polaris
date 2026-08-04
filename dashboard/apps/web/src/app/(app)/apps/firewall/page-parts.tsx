"use client";

/**
 * The two pieces every page under the firewall is built from.
 *
 * Each rule now opens into a page of its own - a custom rule, a managed pack, the
 * address lists - and all three drew the same back button and the same titled
 * surface. Three copies of a header is three chances for one of them to lose its
 * label or grow a different corner radius.
 */

import { ArrowLeft } from "lucide-react";

/** The title of a page you got to by opening something, with the way back. */
export function PageHeader({ title, onBack }: { title: string; onBack: () => void }) {
    return (
        <div className="flex items-center gap-2">
            <button
                type="button"
                onClick={onBack}
                aria-label="Back to the rule list"
                title="Back"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
                <ArrowLeft className="size-4 shrink-0" aria-hidden="true" />
            </button>
            <h2 className="min-w-0 truncate text-lg font-semibold">{title}</h2>
        </div>
    );
}

/** One titled block. A sibling surface, never nested inside another one. */
export function Section({
    title,
    hint,
    children
}: {
    title: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <section className="flex flex-col gap-3 rounded-lg border border-border bg-card px-4 py-4">
            <div className="flex flex-col gap-1">
                <h3 className="text-sm font-semibold">{title}</h3>
                {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
            </div>
            {children}
        </section>
    );
}
