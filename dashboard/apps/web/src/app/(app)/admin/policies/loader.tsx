"use client";

import { PoliciesAdmin } from "./policies-admin";
import { loadPoliciesAdminAction } from "./data";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

export function PoliciesAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-policies"
            load={loadPoliciesAdminAction}
            revision={revision}
            skeleton={<TableSkeleton rows={5} />}
        >
            {(data) => <PoliciesAdmin policies={data.policies} principals={data.principals} />}
        </AfterPaint>
    );
}
