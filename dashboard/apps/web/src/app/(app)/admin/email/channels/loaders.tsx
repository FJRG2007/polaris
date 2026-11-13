"use client";

/**
 * The channel screens' data, asked for after their shells paint. Each view draws
 * its own heading, so the page hands the same heading in for the skeleton and
 * it is on screen before the data is.
 */

import type { ReactNode } from "react";
import { paintRead } from "../../paint-read";
import { AfterPaint } from "@/components/after-paint";
import { ChannelsView } from "./channels-view";
import { CardSkeleton } from "../../region-skeletons";

type Shell = { skeleton: ReactNode; revision: number };

export function ChannelsLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.channels"
            load={() => paintRead("channels")}
            revision={revision}
            skeleton={skeleton}
        >
            {(data) => <ChannelsView initialChannels={data.channels} />}
        </AfterPaint>
    );
}

export const cardsSkeleton = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
    </div>
);
