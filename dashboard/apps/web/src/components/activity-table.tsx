"use client";

/**
 * The audit table, shared by the administrator reading the whole deployment and
 * by a user reading their own account. One component so both read the same way:
 * the same columns, the same expandable metadata, the same shape while the rows
 * are in flight.
 *
 * The second column is the only thing the two screens disagree about - an
 * administrator needs to know who acted, a user already knows and needs to know
 * which of their devices did - so it is passed in rather than duplicated into a
 * second table that would drift from this one.
 */

import { Badge, Skeleton } from "@polaris/ui";
import { useDisplayFormat } from "@/components/display-format";
import { ActivityDetails } from "@/components/activity-details";

/** Rows sketched while the first answer is in flight; about a screenful. */
const SKELETON_ROWS = 12;

/** "drive.file.uploaded" reads as "Drive file uploaded". The exact action stays
 *  on the badge's title, for the reader who is matching it against a log. */
function label(action: string): string {
    const words = action.replace(/[.\-_]+/g, " ").trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
}

export interface ActivityRow {
    id: string;
    /** ISO 8601; formatted here with the reader's own preferences. */
    at: string;
    /** Who acted, or where the action came from - see `contextLabel`. */
    context: string;
    action: string;
    /** What the action was aimed at, when it named something. */
    detail?: string;
    /** The raw metadata document, or "" when the entry carried none. */
    metadata: string;
}

export function ActivityTable({
    rows,
    loading,
    error,
    contextLabel,
    emptyLabel
}: {
    rows: ActivityRow[] | null;
    loading: boolean;
    error: string | null;
    /** Heading for the second column: "Who" for the deployment, "Session" for an account. */
    contextLabel: string;
    emptyLabel: string;
}) {
    const format = useDisplayFormat();

    return (
        <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
                <thead className="bg-surface/60 text-left text-xs text-muted-foreground">
                    <tr>
                        <th className="px-3 py-2 font-medium">When</th>
                        {/* Folded into the action cell until there is room for it:
                            what happened is what the row is for, and it must never
                            be the column left hanging off the edge.

                            Nothing arrives at md - the navigation rail appears
                            there, so the content area is narrower than it was a
                            breakpoint earlier and a column added then only puts the
                            table on a scrollbar. */}
                        <th className="hidden px-3 py-2 font-medium lg:table-cell">{contextLabel}</th>
                        {/* w-full max-w-0: the folded context line is nowrap text and
                            would otherwise set a floor under this column that no amount
                            of truncating gets below, spilling the table sideways.
                            Capped, it takes whatever is left instead. */}
                        <th className="w-full max-w-0 px-3 py-2 font-medium">Action</th>
                        <th className="hidden px-3 py-2 font-medium xl:table-cell">Details</th>
                    </tr>
                </thead>
                <tbody>
                    {loading ? (
                        <ActivityRowsSkeleton />
                    ) : error ? (
                        <tr>
                            <td colSpan={4} className="px-3 py-8 text-center text-danger">
                                {error}
                            </td>
                        </tr>
                    ) : (rows?.length ?? 0) === 0 ? (
                        <tr>
                            <td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">
                                {emptyLabel}
                            </td>
                        </tr>
                    ) : (
                        rows?.map((row) => (
                            <tr key={row.id} className="border-t border-border hover:bg-card-hover">
                                <td className="whitespace-nowrap px-3 py-2 align-top text-muted-foreground">
                                    {format.dateTime(row.at)}
                                </td>
                                {/* The width lives on the span: a cell's own max-width
                                    is not what an auto table lays a column out by, so
                                    the truncation has to be given something to bite on. */}
                                <td className="hidden px-3 py-2 align-top lg:table-cell">
                                    <span className="block max-w-[14rem] truncate">{row.context}</span>
                                </td>
                                <td className="w-full max-w-0 px-3 py-2 align-top">
                                    <Badge variant="neutral" title={row.action}>
                                        {label(row.action)}
                                    </Badge>
                                    {/* The target belongs under the action it happened to, not
                                        buried in the metadata a narrow screen never shows. */}
                                    {row.detail ? (
                                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                                            {row.detail}
                                        </span>
                                    ) : null}
                                    <span className="mt-0.5 block truncate text-xs text-muted-foreground lg:hidden">
                                        {row.context}
                                    </span>
                                </td>
                                <td className="hidden px-3 py-2 align-top text-xs text-muted-foreground xl:table-cell">
                                    <ActivityDetails metadata={row.metadata} />
                                </td>
                            </tr>
                        ))
                    )}
                </tbody>
            </table>
        </div>
    );
}

/** The rows' own shape, so the table does not jump when they arrive. */
function ActivityRowsSkeleton() {
    return (
        <>
            {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
                <tr key={index} className="border-t border-border">
                    <td className="px-3 py-2">
                        <Skeleton className="h-4 w-32" />
                    </td>
                    <td className="hidden px-3 py-2 lg:table-cell">
                        <Skeleton className="h-4 w-28" />
                    </td>
                    <td className="px-3 py-2">
                        <Skeleton className="h-5 w-24 rounded-full" />
                    </td>
                    <td className="hidden px-3 py-2 lg:table-cell">
                        <Skeleton className="h-4 w-full max-w-md" />
                    </td>
                </tr>
            ))}
        </>
    );
}
