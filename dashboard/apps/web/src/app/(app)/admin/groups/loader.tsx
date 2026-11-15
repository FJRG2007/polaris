"use client";

import { GroupsAdmin, type GroupRow } from "./groups-admin";
import { loadGroupsAdminAction } from "./data";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

export function GroupsAdminLoader({
    revision,
    streamed
}: {
    revision: number;
    /** The read the page started, streamed in with it. */
    streamed?: Promise<GroupRow[]>;
}) {
    return (
        <AfterPaint
            cacheKey="admin-groups"
            load={loadGroupsAdminAction}
            streamed={streamed}
            revision={revision}
            skeleton={<TableSkeleton rows={6} />}
        >
            {(groups) => <GroupsAdmin groups={groups} />}
        </AfterPaint>
    );
}
