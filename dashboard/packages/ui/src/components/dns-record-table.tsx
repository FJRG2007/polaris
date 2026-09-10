/**
 * DNS records somebody has to create at their registrar, as a table in the
 * columns a registrar's own list uses: type, name, content, and whether each is
 * in place yet.
 *
 * A record is copied field by field into a form with a field for each, so the
 * name and the content each carry their own copy button rather than one for the
 * whole line. Both are shown whole, wrapped rather than cut, because a value
 * pasted from a truncated cell is the wrong value. A value that is not known
 * yet - the server's address before it is detected - is said in words and offers
 * no copy, since copying the words would be worse than nothing.
 */

import { cn } from "../lib/cn";
import { Badge } from "./badge";
import type { ReactNode } from "react";
import { CopyButton } from "./copy-button";
import { CheckCircle2, Clock, TriangleAlert } from "lucide-react";

export type DnsRecordStatus = "done" | "waiting" | "conflict";

export interface DnsRecordRow {
    /** A, AAAA, CNAME, TXT, MX... */
    readonly type: string;
    readonly name: string;
    /** Null when it is not known yet; `valueFallback` says what goes there instead. */
    readonly value: string | null;
    readonly valueFallback?: string;
    readonly status?: DnsRecordStatus;
    /** Overrides the status's own words. */
    readonly statusLabel?: string;
    /** What the record is for, in one line. */
    readonly note?: ReactNode;
}

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

export function DnsRecordTable({ records, className }: { records: readonly DnsRecordRow[]; className?: string }) {
    const withStatus = records.some((record) => record.status);
    return (
        <div className={cn("min-w-0 overflow-x-auto rounded-lg border border-border bg-card", className)}>
            <table className="w-full min-w-[32rem] text-sm">
                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                    <tr>
                        <th scope="col" className="w-16 px-3 py-2 font-medium">
                            Type
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                            Name
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                            Content
                        </th>
                        {withStatus && (
                            <th scope="col" className="px-3 py-2 font-medium">
                                Status
                            </th>
                        )}
                    </tr>
                </thead>
                <tbody>
                    {records.map((record) => (
                        <tr key={`${record.type} ${record.name}`} className="border-t border-border align-top">
                            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">
                                {record.type}
                            </td>
                            <td className="px-3 py-2">
                                <span className="flex items-start gap-1.5">
                                    <code className="min-w-0 break-all font-mono text-xs text-foreground">
                                        {record.name}
                                    </code>
                                    <CopyButton value={record.name} label={`name ${record.name}`} className="mt-px shrink-0" />
                                </span>
                                {record.note ? (
                                    <span className="mt-0.5 block text-xs text-muted-foreground">{record.note}</span>
                                ) : null}
                            </td>
                            <td className="px-3 py-2">
                                {record.value !== null ? (
                                    <span className="flex items-start gap-1.5">
                                        <code className="min-w-0 break-all font-mono text-xs text-foreground">
                                            {record.value}
                                        </code>
                                        <CopyButton
                                            value={record.value}
                                            label={`value ${record.value}`}
                                            className="mt-px shrink-0"
                                        />
                                    </span>
                                ) : (
                                    <span className="text-xs italic text-muted-foreground">
                                        {record.valueFallback ?? "not known yet"}
                                    </span>
                                )}
                            </td>
                            {withStatus && (
                                <td className="whitespace-nowrap px-3 py-2">
                                    {record.status ? (
                                        <Badge variant={STATUS[record.status].variant}>
                                            <StatusIcon status={record.status} />
                                            {record.statusLabel ?? STATUS[record.status].label}
                                        </Badge>
                                    ) : null}
                                </td>
                            )}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
