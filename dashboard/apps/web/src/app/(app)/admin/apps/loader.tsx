"use client";

import type { ReactNode } from "react";
import { paintRead } from "../paint-read";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { MarketplaceView } from "@/app/(app)/apps/marketplace/marketplace-view";

/** The Polaris apps, drawn by the marketplace view once the installs are read. */
export function PolarisAppsLoader({
    heading,
    initialQuery,
    revision
}: {
    /** The view's own header, drawn by the page so it paints with the shell. */
    heading: ReactNode;
    initialQuery: string;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin.apps"
            load={() => paintRead("apps")}
            revision={revision}
            skeleton={
                <>
                    {heading}
                    <TableSkeleton rows={6} />
                </>
            }
        >
            {(data) => (
                <MarketplaceView
                    scope="polaris"
                    installed={data.installed}
                    initialQuery={initialQuery}
                    canInstall={data.canInstall}
                    canUpdateApps={data.canUpdateApps}
                />
            )}
        </AfterPaint>
    );
}
