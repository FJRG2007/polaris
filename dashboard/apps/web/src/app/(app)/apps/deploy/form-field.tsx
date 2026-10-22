import type { ReactNode } from "react";

/** One labelled control of a Deploy form, with its hint or what is wrong with it. */
export function Field({
    label,
    hint,
    error,
    children
}: {
    label: string;
    hint?: string;
    error?: string;
    children: ReactNode;
}) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">{label}</span>
            {children}
            {error ? (
                <span className="text-xs text-danger">{error}</span>
            ) : hint ? (
                <span className="text-xs text-muted-foreground/70">{hint}</span>
            ) : null}
        </label>
    );
}
