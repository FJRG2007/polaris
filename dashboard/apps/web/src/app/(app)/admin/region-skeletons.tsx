/**
 * The shapes a Management screen shows where its data will land, while the
 * request for it is out: a table of rows, or a card of fields. Shaped like the
 * content so nothing jumps when it arrives.
 */

import { Skeleton } from "@polaris/ui";

/** A toolbar over a table of `rows` lines. */
export function TableSkeleton({ rows = 8 }: { rows?: number }) {
    return (
        <div className="flex flex-col gap-3" aria-hidden="true">
            <div className="flex items-center justify-between gap-3">
                <Skeleton className="h-9 w-full max-w-sm" />
                <Skeleton className="h-9 w-28 shrink-0" />
            </div>
            <div className="flex flex-col divide-y divide-border rounded-lg border">
                {Array.from({ length: rows }, (_, index) => (
                    <div key={index} className="flex items-center gap-3 px-4 py-3">
                        <Skeleton className="size-8 shrink-0 rounded-full" />
                        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                            <Skeleton className="h-4 w-40 max-w-full" />
                            <Skeleton className="h-3 w-56 max-w-full" />
                        </div>
                        <Skeleton className="h-6 w-16 shrink-0" />
                    </div>
                ))}
            </div>
        </div>
    );
}

/** A card with a title and `lines` fields under it. */
export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
    return (
        <div
            className={`flex flex-col gap-3 rounded-lg border p-4 ${className ?? ""}`}
            aria-hidden="true"
        >
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64 max-w-full" />
            {Array.from({ length: lines }, (_, index) => (
                <Skeleton key={index} className="h-9 w-full" />
            ))}
        </div>
    );
}

/** The name and address at the top of one person's record. */
export function RecordHeaderSkeleton() {
    return (
        <div className="mb-4 flex flex-col gap-2" aria-hidden="true">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-64 max-w-full" />
        </div>
    );
}
