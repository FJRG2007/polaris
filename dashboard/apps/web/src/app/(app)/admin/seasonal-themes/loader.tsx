"use client";

import { paintRead } from "../paint-read";
import { CardSkeleton } from "../region-skeletons";
import { SeasonalAdminCard } from "./seasonal-card";
import { AfterPaint } from "@/components/after-paint";

export function SeasonalLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.seasonal"
            load={() => paintRead("seasonal")}
            revision={revision}
            skeleton={<CardSkeleton lines={2} />}
        >
            {(data) => (
                <SeasonalAdminCard
                    initial={data.seasons}
                    calendar={data.calendar}
                    preview={data.preview}
                />
            )}
        </AfterPaint>
    );
}
