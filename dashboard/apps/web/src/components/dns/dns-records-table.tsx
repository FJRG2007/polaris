"use client";

/**
 * A zone's records as a table, in the columns Cloudflare's own list uses: type,
 * name, content, proxy status, TTL, and what can be done to each.
 *
 * It was a stack of cards, one per record, which is the right shape for three
 * records and the wrong one for forty: every card a different height, and the
 * question a zone is opened with - where does this name point - answerable only
 * by reading each in turn. A value too long for its column is cut short and kept
 * whole in its title and its copy button, because the other half of DNS work is
 * pasting one of them somewhere else.
 *
 * Presentational: the editor owns the records, the filters and the writes. Rows
 * a write has not come back for yet are drawn dimmed and cannot be acted on
 * again until it does.
 */

import { Fragment, type ReactNode } from "react";
import { ttlLabel } from "@/lib/dns/records-view";
import { Button, Skeleton, cn } from "@polaris/ui";
import { Pencil, Radar, Trash2 } from "lucide-react";
import { CopyButton } from "@/components/copy-button";
import type { DnsRecordView } from "@/lib/dns/zone-records";

/** The rows a skeleton draws while the first read is on its way. */
const SKELETON_ROWS = 5;

export function DnsRecordsTable({
    records,
    pending,
    checking,
    expanded,
    empty,
    onCheck,
    onEdit,
    onDelete
}: {
    /** Null while there is nothing to show yet: the rows pulse, the header does not. */
    records: readonly DnsRecordView[] | null;
    /** Rows whose write has not come back yet. */
    pending: ReadonlySet<string>;
    /** The record whose propagation is open under its row. */
    checking: string | null;
    /** What opens under the checked row. */
    expanded?: ReactNode;
    /** Said in place of the rows when there are none. */
    empty: ReactNode;
    onCheck: (record: DnsRecordView) => void;
    onEdit: (record: DnsRecordView) => void;
    onDelete: (record: DnsRecordView) => void;
}) {
    return (
        // Scrolls sideways rather than squeezing: six columns on a phone would be
        // six unreadable ones.
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full min-w-[46rem] text-sm">
                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                    <tr>
                        <th scope="col" className="w-20 px-3 py-2 font-medium">
                            Type
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                            Name
                        </th>
                        <th scope="col" className="w-full max-w-0 px-3 py-2 font-medium">
                            Content
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                            Proxy status
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                            TTL
                        </th>
                        <th scope="col" className="px-3 py-2 text-right font-medium">
                            <span className="sr-only">Actions</span>
                        </th>
                    </tr>
                </thead>
                <tbody aria-busy={records === null ? true : undefined}>
                    {records === null ? (
                        Array.from({ length: SKELETON_ROWS }, (_, row) => (
                            <tr key={row} className="border-t border-border">
                                <td className="px-3 py-2.5">
                                    <Skeleton className="h-4 w-10" />
                                </td>
                                <td className="px-3 py-2.5">
                                    <Skeleton className="h-4 w-28" />
                                </td>
                                <td className="max-w-0 px-3 py-2.5">
                                    <Skeleton className="h-4 w-3/4" />
                                </td>
                                <td className="px-3 py-2.5">
                                    <Skeleton className="h-4 w-16" />
                                </td>
                                <td className="px-3 py-2.5">
                                    <Skeleton className="h-4 w-10" />
                                </td>
                                <td className="px-3 py-2.5">
                                    <Skeleton className="ml-auto h-4 w-20" />
                                </td>
                            </tr>
                        ))
                    ) : records.length === 0 ? (
                        <tr className="border-t border-border">
                            <td colSpan={6} className="px-3 py-8 text-center text-muted-foreground">
                                {empty}
                            </td>
                        </tr>
                    ) : (
                        records.map((record) => (
                            <Fragment key={record.id}>
                                <RecordRow
                                    record={record}
                                    pending={pending.has(record.id)}
                                    checking={checking === record.id}
                                    onCheck={() => onCheck(record)}
                                    onEdit={() => onEdit(record)}
                                    onDelete={() => onDelete(record)}
                                />
                                {checking === record.id && expanded ? (
                                    <tr className="bg-surface/40">
                                        <td colSpan={6} className="px-3 py-2.5">
                                            {expanded}
                                        </td>
                                    </tr>
                                ) : null}
                            </Fragment>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}

function RecordRow({
    record,
    pending,
    checking,
    onCheck,
    onEdit,
    onDelete
}: {
    record: DnsRecordView;
    pending: boolean;
    checking: boolean;
    onCheck: () => void;
    onEdit: () => void;
    onDelete: () => void;
}) {
    // A type the editor does not write (an HTTPS or PTR record Cloudflare holds)
    // is listed and can be removed, but not changed from here.
    const editable = record.draft !== null && !pending;
    const described = `${record.type} record ${record.relative}`;
    return (
        <tr
            aria-busy={pending ? true : undefined}
            className={cn("border-t border-border align-top hover:bg-card-hover", pending && "opacity-60")}
        >
            <td className="whitespace-nowrap px-3 py-2 font-mono text-xs font-semibold">{record.type}</td>
            <td className="px-3 py-2">
                <span className="flex items-center gap-1.5">
                    <span className="block max-w-[16rem] truncate font-medium" title={record.name}>
                        {record.relative}
                    </span>
                    <CopyButton value={record.name} label={`name ${record.name}`} className="shrink-0" />
                </span>
            </td>
            <td className="max-w-0 px-3 py-2">
                <span className="flex min-w-0 items-center gap-1.5">
                    {record.type === "MX" && record.priority !== null ? (
                        <span className="shrink-0 font-mono text-xs text-foreground-subtle" title="Priority">
                            {record.priority}
                        </span>
                    ) : null}
                    <code className="min-w-0 truncate font-mono text-xs" title={record.content}>
                        {record.content || "-"}
                    </code>
                    {record.content ? (
                        <CopyButton value={record.content} label={`content ${record.content}`} className="shrink-0" />
                    ) : null}
                </span>
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {record.proxiable ? (record.proxied ? "Proxied" : "DNS only") : "-"}
            </td>
            <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">
                {ttlLabel(record.ttl)}
            </td>
            <td className="whitespace-nowrap px-3 py-1">
                <span className="flex items-center justify-end gap-0.5">
                    {editable && (
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={onCheck}
                            aria-label={`Check where the ${described} has reached`}
                            aria-pressed={checking}
                            title="Check propagation"
                        >
                            <Radar className="size-4" />
                        </Button>
                    )}
                    {editable && (
                        <Button
                            size="icon-sm"
                            variant="ghost"
                            onClick={onEdit}
                            aria-label={`Edit the ${described}`}
                            title="Edit"
                        >
                            <Pencil className="size-4" />
                        </Button>
                    )}
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={onDelete}
                        disabled={pending}
                        aria-label={`Delete the ${described}`}
                        title="Delete"
                    >
                        <Trash2 className="size-4" />
                    </Button>
                </span>
            </td>
        </tr>
    );
}
