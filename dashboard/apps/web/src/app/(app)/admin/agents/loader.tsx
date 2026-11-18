"use client";

import { paintRead } from "../paint-read";
import { CardSkeleton } from "../region-skeletons";
import { UsageLimitsCard } from "./usage-limits-card";
import { AfterPaint } from "@/components/after-paint";
import { PlatformDefaultsView } from "./platform-defaults-view";
import { CatalogCard, KeySharingCard } from "./catalog-card";

export function AgentsAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.agents"
            load={() => paintRead("agents")}
            revision={revision}
            skeleton={
                <div className="space-y-4">
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
                    <UsageLimitsCard limits={data.limits} />
                    <CatalogCard
                        models={data.catalogModels}
                        refreshedAt={data.catalogAt}
                        index={data.providerIndex ?? null}
                    />
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
