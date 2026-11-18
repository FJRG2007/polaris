"use client";

import { RolesAdmin } from "./roles-admin";
import { loadRolesAdminAction } from "./data";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { PolarAudienceCard } from "./polar-audience-card";

export function RolesAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-roles"
            load={loadRolesAdminAction}
            revision={revision}
            skeleton={<TableSkeleton rows={5} />}
        >
            {(data) => (
                <div className="flex flex-col gap-4">
                    <RolesAdmin roles={data.roles} listed={data.listed} />
                    {/* A read cached by a build before this card has no `polar`. */}
                    {data.polar && data.listed.includes("polar.use") ? (
                        <PolarAudienceCard
                            policy={data.polar.policy}
                            groups={data.polar.groups}
                            moreGroups={data.polar.moreGroups}
                            chosenGroups={data.polar.chosenGroups}
                            people={data.polar.people}
                        />
                    ) : null}
                </div>
            )}
        </AfterPaint>
    );
}
