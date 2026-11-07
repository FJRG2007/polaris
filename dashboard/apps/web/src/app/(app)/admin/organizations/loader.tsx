"use client";

import { saveOrganizationPolicyAction } from "./actions";
import { TableSkeleton } from "../region-skeletons";
import { loadOrganizationsAdminAction } from "./data";
import { AfterPaint } from "@/components/after-paint";
import { OrganizationsAdmin } from "./organizations-admin";

export function OrganizationsAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-organizations"
            load={loadOrganizationsAdminAction}
            revision={revision}
            skeleton={<TableSkeleton rows={8} />}
        >
            {(data) => (
                <OrganizationsAdmin
                    initial={data.policy}
                    save={saveOrganizationPolicyAction}
                    first={data.orgs}
                />
            )}
        </AfterPaint>
    );
}
