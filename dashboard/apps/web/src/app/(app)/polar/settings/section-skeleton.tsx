/**
 * What a settings page shows while it resolves, inside the settings sidebar
 * that stays put: its heading and intro, then the shape its content takes - a
 * list of rows, a table, or a block of text - so what appears lands where the
 * sketch was.
 */

import { Skeleton } from "@polaris/ui";

export type SkeletonPart =
    | { kind: "rows"; count: number }
    | { kind: "table"; count: number }
    | { kind: "block" }
    | { kind: "banner" };

export function SectionSkeleton({ parts }: { parts: readonly SkeletonPart[] }) {
    return (
        <div className="flex min-w-0 flex-col gap-6" aria-hidden>
            <div className="flex flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-full max-w-md" />
            </div>
            {parts.map((part, index) =>
                part.kind === "banner" ? (
                    <Skeleton key={index} className="h-14 w-full" />
                ) : part.kind === "block" ? (
                    <Skeleton key={index} className="h-40 w-full" />
                ) : (
                    <div
                        key={index}
                        className="flex flex-col divide-y divide-border rounded-md border border-border"
                    >
                        {part.kind === "table" ? (
                            <div className="flex items-center gap-3 bg-surface/60 px-3 py-2">
                                <Skeleton className="h-3 flex-1" />
                                <Skeleton className="h-3 w-16" />
                                <Skeleton className="h-3 w-16" />
                            </div>
                        ) : null}
                        {Array.from({ length: part.count }, (_, row) => (
                            <div key={row} className="flex items-center gap-3 px-3 py-2.5">
                                <Skeleton className="size-5 shrink-0 rounded" />
                                <Skeleton className="h-4 flex-1" />
                                <Skeleton className="h-4 w-20" />
                            </div>
                        ))}
                    </div>
                )
            )}
        </div>
    );
}
