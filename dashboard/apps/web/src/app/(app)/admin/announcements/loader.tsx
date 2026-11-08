"use client";

import type { ComponentProps } from "react";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { AnnouncementsView } from "./announcements-view";
import { loadAnnouncementPicksAction } from "./data";

type ViewProps = ComponentProps<typeof AnnouncementsView>;

export function AnnouncementsLoader({
    locale,
    templates,
    revision
}: {
    locale: ViewProps["locale"];
    templates: ViewProps["templates"];
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey="admin-announcement-picks"
            load={loadAnnouncementPicksAction}
            revision={revision}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={5} />
                    <CardSkeleton lines={3} />
                </div>
            }
        >
            {(picks) => (
                <AnnouncementsView
                    locale={locale}
                    templates={templates}
                    roles={picks.roles}
                    groups={picks.groups}
                    orgs={picks.orgs}
                />
            )}
        </AfterPaint>
    );
}
