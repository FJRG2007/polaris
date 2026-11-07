"use client";

import { GroupsAdmin } from "./groups-admin";
import { loadGroupsAdminAction } from "./data";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

export function GroupsAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-groups"
            load={loadGroupsAdminAction}
            revision={revision}
            skeleton={<TableSkeleton rows={6} />}
        >
            {(groups) => <GroupsAdmin groups={groups} />}
        </AfterPaint>
    );
}
