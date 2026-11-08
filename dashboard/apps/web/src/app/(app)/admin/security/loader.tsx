"use client";

import { SecurityAdmin } from "./security-admin";
import { loadSecurityAdminAction } from "./data";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";
import { PlayerAddressesCard } from "./player-addresses-card";

/** Sign-in rules are security settings, so they are never kept in the tab. */
export function SecurityAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin-security"
            load={loadSecurityAdminAction}
            persist={false}
            revision={revision}
            skeleton={
                <>
                    <CardSkeleton lines={4} />
                    <CardSkeleton lines={4} />
                    <CardSkeleton lines={1} className="max-w-2xl" />
                </>
            }
        >
            {(data) => (
                <>
                    <SecurityAdmin policy={data.policy} mailReady={data.mailReady} />
                    <div className="max-w-2xl">
                        <PlayerAddressesCard shared={data.addressesShared} />
                    </div>
                </>
            )}
        </AfterPaint>
    );
}
