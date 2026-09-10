/**
 * One DNS record somebody has to create at their registrar, drawn the way a
 * registrar's form asks for it: the type as an inverted chip, then each field
 * as a label and a value, every value with its own copy button.
 *
 * A record is copied field by field into a form with a field for each, so a
 * single "copy the record" would hand over a line nobody can paste. A value that
 * is not known yet - the server's address before it is detected - is said in
 * words and offers no copy, since copying the words would be worse than nothing.
 */

import { cn } from "../lib/cn";
import { Badge } from "./badge";
import type { ReactNode } from "react";
import { CopyButton } from "./copy-button";
import { CheckCircle2, Clock, TriangleAlert } from "lucide-react";

export interface DnsRecordField {
    readonly label: string;
    /** Null when it is not known yet; `fallback` says what goes there instead. */
    readonly value: string | null;
    readonly fallback?: string;
}

export type DnsRecordStatus = "done" | "waiting" | "conflict";

const STATUS: Record<DnsRecordStatus, { label: string; variant: "success" | "neutral" | "warning" }> = {
    done: { label: "In place", variant: "success" },
    waiting: { label: "Not seen yet", variant: "neutral" },
    conflict: { label: "Points elsewhere", variant: "warning" }
};

function StatusIcon({ status }: { status: DnsRecordStatus }) {
    if (status === "done") return <CheckCircle2 className="size-3" aria-hidden />;
    if (status === "conflict") return <TriangleAlert className="size-3" aria-hidden />;
    return <Clock className="size-3" aria-hidden />;
}

export function DnsRecordCard({
    type,
    name,
    value,
    valueFallback = "not known yet",
    fields = [],
    status,
    statusLabel,
    note,
    className
}: {
    /** A, AAAA, CNAME, TXT, MX... */
    type: string;
    name: string;
    value: string | null;
    /** Said in place of a value that is not known yet. */
    valueFallback?: string;
    /** Anything else the form asks for: TTL, priority. */
    fields?: readonly DnsRecordField[];
    status?: DnsRecordStatus;
    /** Overrides the status's own words. */
    statusLabel?: string;
    /** What the record is for, in one line. */
    note?: ReactNode;
    className?: string;
}) {
    const rows: DnsRecordField[] = [
        { label: "Name", value: name },
        { label: "Value", value, fallback: valueFallback },
        ...fields
    ];
    return (
        <div className={cn("min-w-0 rounded-lg border border-border bg-card", className)}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/60 px-3 py-2">
                <span className="rounded bg-foreground px-1.5 py-px font-mono text-[0.6875rem] font-semibold uppercase leading-[18px] text-background">
                    {type}
                </span>
                {note && <span className="min-w-0 flex-1 text-xs text-muted-foreground">{note}</span>}
                {status && (
                    <Badge variant={STATUS[status].variant} className="ml-auto">
                        <StatusIcon status={status} />
                        {statusLabel ?? STATUS[status].label}
                    </Badge>
                )}
            </div>
            <dl className="grid grid-cols-1 gap-x-3 px-3 py-1.5 sm:grid-cols-[4.5rem_minmax(0,1fr)]">
                {rows.map((row) => (
                    <div key={row.label} className="contents">
                        <dt className="pt-1.5 text-[0.6875rem] font-medium uppercase tracking-wide text-foreground-subtle sm:py-1.5">
                            {row.label}
                        </dt>
                        <dd className="flex min-w-0 items-start gap-2 pb-1.5 sm:py-1.5">
                            {row.value !== null ? (
                                <>
                                    <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground">
                                        {row.value}
                                    </code>
                                    <CopyButton
                                        value={row.value}
                                        label={`${row.label.toLowerCase()} ${row.value}`}
                                        className="mt-px shrink-0"
                                    />
                                </>
                            ) : (
                                <span className="text-xs italic text-muted-foreground">{row.fallback ?? "not known yet"}</span>
                            )}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
