"use client";

/**
 * What a screen shows while the page behind it is still resolving.
 *
 * Both halves of the same idea live here. `RouteSkeletonCapture` marks the
 * content region so `npx boneyard-js build` can record what each screen really
 * renders (see dashboard/docs/skeletons.md), and `RouteSkeleton` draws that
 * recording back on the next navigation. A screen with no recording falls back
 * to a generic heading and a few rows, so a new route is never worse off than
 * it was before.
 */

import { ROUTE_BONES } from "@/bones";
import { usePathname } from "next/navigation";
import { BoneSkeleton, Skeleton } from "@polaris/ui";
import { useEffect, useState, type ReactNode } from "react";

declare global {
    interface Window {
        /** Set by the boneyard CLI before the page loads, while it captures. */
        __BONEYARD_BUILD?: boolean;
        /** The extractor the CLI calls to read bones out of the live DOM. */
        __BONEYARD_SNAPSHOT?: unknown;
    }
}

/** The name a route's capture is filed under, in the URL and in `src/bones`. */
export function routeSkeletonName(pathname: string) {
    const slug = pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-zA-Z0-9]+/g, "-");
    return slug ? `route-${slug}` : "route-root";
}

/**
 * Marks the content region for a capture run and renders the page untouched
 * otherwise: outside a run this adds no element and no work. The wrapper appears
 * only after mount so the server and the browser agree on the first render, and
 * the CLI's own wait window covers the extra tick.
 */
export function RouteSkeletonCapture({ children }: { children: ReactNode }) {
    const pathname = usePathname();
    const [capturing, setCapturing] = useState(false);

    useEffect(() => {
        if (window.__BONEYARD_BUILD !== true) return;
        setCapturing(true);
        // The CLI reads the DOM through the extractor the page exposes. It only
        // ships in a capture run, so it is loaded here rather than imported.
        void import("boneyard-js").then((boneyard) => {
            window.__BONEYARD_SNAPSHOT = boneyard.snapshotBones;
        });
    }, []);

    if (!capturing) return <>{children}</>;
    return (
        <div data-boneyard={routeSkeletonName(pathname)}>
            <div>{children}</div>
        </div>
    );
}

/** The placeholder itself. Rendered by the route group's `loading.tsx`. */
export function RouteSkeleton() {
    const pathname = usePathname();
    return <BoneSkeleton layout={ROUTE_BONES[routeSkeletonName(pathname)]} fallback={<GenericSkeleton />} />;
}

/**
 * The shape of a heading and a few rows. It fits a table, a list of cards and a
 * form closely enough to carry a screen that has not been captured yet.
 */
function GenericSkeleton() {
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
