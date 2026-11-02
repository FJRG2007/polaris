/** A labelled control of the router's dialogs, with its error or hint beneath. */
export function Field({
    id,
    label,
    error,
    hint,
    children
}: {
    id: string;
    label: string;
    error?: string | null;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-sm font-medium">
                {label}
            </label>
            {children}
            {error ? (
                <p role="alert" className="text-xs text-danger">
                    {error}
                </p>
            ) : hint ? (
                <p className="text-xs text-muted-foreground">{hint}</p>
            ) : null}
        </div>
    );
}
