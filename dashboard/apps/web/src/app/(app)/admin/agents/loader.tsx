"use client";

import { paintRead } from "../paint-read";
import { CardSkeleton } from "../region-skeletons";
import { UsageLimitsCard } from "./usage-limits-card";
import { PolarAccessCard } from "./polar-access-card";
import { AfterPaint } from "@/components/after-paint";
import { PlatformDefaultsView } from "./platform-defaults-view";
import { CatalogCard, KeySharingCard, SharedWorkspaceCard } from "./catalog-card";

export function AgentsAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.agents"
            load={() => paintRead("agents")}
            revision={revision}
            skeleton={
                <div className="space-y-4">
                    <CardSkeleton lines={1} />
                    <CardSkeleton lines={2} />
                    <CardSkeleton lines={1} />
                    <CardSkeleton lines={3} />
                    <CardSkeleton lines={1} />
                    <CardSkeleton lines={4} />
                </div>
            }
        >
            {(data) => (
                <div className="space-y-4">
                    <KeySharingCard shared={data.keysShared} />
                    <PolarAccessCard
                        policy={data.polarPolicy}
                        groups={data.groups}
                        moreGroups={data.moreGroups}
                        chosenGroups={data.chosenGroups}
                        people={data.people}
                    />
                    <SharedWorkspaceCard allowed={data.sharedMachine} />
                    <UsageLimitsCard limits={data.limits} />
                    <CatalogCard models={data.catalogModels} refreshedAt={data.catalogAt} />
                    <PlatformDefaultsView
                        platform={data.platform}
                        pools={data.pools}
                        providers={data.providers}
                    />
                </div>
            )}
        </AfterPaint>
    );
}
