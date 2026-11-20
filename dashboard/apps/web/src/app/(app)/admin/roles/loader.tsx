"use client";

import { RolesAdmin } from "./roles-admin";
import { loadRolesAdminAction } from "./data";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

export function RolesAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-roles"
            load={loadRolesAdminAction}
            revision={revision}
            skeleton={<TableSkeleton rows={5} />}
        >
            {(data) => <RolesAdmin roles={data.roles} listed={data.listed} />}
        </AfterPaint>
    );
}
