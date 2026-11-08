"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { paintRead } from "@/app/(app)/admin/paint-read";
import { MovedRegion } from "@/app/(app)/admin/moved-region";
import { AfterPaint } from "@/components/after-paint";
import { AppServicesPanel, AppServicesSkeleton } from "./app-services-panel";

/**
 * An app's settings below the page's header: the services it runs, its own
 * settings, the way to where they are drawn - or, when the data says there are
 * none here, not found or a move to where they are.
 */
export function AppSettingsLoader({
    appId,
    elsewhereLabel,
    own,
    revision
}: {
    appId: string;
    /** "<app> settings", for the link to settings drawn on another screen. */
    elsewhereLabel: string;
    /** The app's own settings panel, drawn by the page when it has one. */
    own: ReactNode;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey={`admin.app-settings:${appId}`}
            load={() => paintRead("apps.settings", { appId })}
            persist={false}
            revision={revision}
            skeleton={<AppServicesSkeleton />}
        >
            {(data) =>
                data.screen === "moved" ? (
                    <MovedRegion to={data.to}>
                        <AppServicesSkeleton />
                    </MovedRegion>
                ) : (
                    <>
                        {data.drawnElsewhere ? (
                            <Link
                                href={data.drawnElsewhere}
                                className="text-primary inline-flex w-fit items-center gap-1 text-sm hover:underline"
                            >
                                {elsewhereLabel}
                            </Link>
                        ) : null}
                        {own}
                        {data.services ? (
                            <AppServicesPanel appId={appId} services={data.services} />
                        ) : null}
                    </>
                )
            }
        </AfterPaint>
    );
}
