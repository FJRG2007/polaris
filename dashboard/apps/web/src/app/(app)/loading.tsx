import { Skeleton } from "@polaris/ui";

/**
 * What every dashboard screen shows while its own page is still resolving.
 *
 * Next renders this the moment a navigation starts, so the chrome stays put and
 * the content area sketches what is coming instead of the previous page sitting
 * there looking clickable. It is deliberately generic - the shape of a heading
 * and a few rows fits a table, a list of cards, and a form closely enough, and a
 * per-screen skeleton would be one more thing to keep in step with the screen.
 */
export default function Loading() {
    return (
        <div aria-busy="true" aria-live="polite">
            <div className="mb-6 flex flex-col gap-2">
                <Skeleton className="h-6 w-48" />
                <Skeleton className="h-4 w-full max-w-xl" />
            </div>
            <div className="flex flex-col gap-3">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
            </div>
        </div>
    );
}
