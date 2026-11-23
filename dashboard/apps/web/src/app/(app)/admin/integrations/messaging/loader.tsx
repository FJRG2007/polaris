"use client";

import { MessagingAdmin } from "./messaging-admin";
import { AfterPaint } from "@/components/after-paint";
import { paintRead } from "@/app/(app)/admin/paint-read";
import { CardSkeleton } from "@/app/(app)/admin/region-skeletons";

/** The channels and the code senders. Not kept in the tab: delivery setup. */
export function MessagingAdminLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.messaging"
            load={() => paintRead("messaging")}
            persist={false}
            revision={revision}
            skeleton={
                <>
                    <CardSkeleton lines={3} />
                    <CardSkeleton lines={2} />
                </>
            }
        >
            {(data) => (
                <MessagingAdmin
                    initialChannels={data.channels}
                    codeSenders={data.codeSenders}
                    smsSenders={data.smsSenders ?? []}
                />
            )}
        </AfterPaint>
    );
}
