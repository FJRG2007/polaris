"use client";

/**
 * The channel screens' data, asked for after their shells paint. Each view draws
 * its own heading, so the page hands the same heading in for the skeleton and
 * it is on screen before the data is.
 */

import type { ReactNode } from "react";
import { paintRead } from "../../paint-read";
import { MovedRegion } from "../../moved-region";
import { AfterPaint } from "@/components/after-paint";
import { ChannelsView } from "./channels-view";
import { CardSkeleton } from "../../region-skeletons";
import { ConnectChannelView } from "./connect/connect-view";

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

/** The channel picker, the way to the bridge, or - with no bridge - the email screen. */
export function ConnectChannelLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.channels.connect"
            load={() => paintRead("channels.connect")}
            persist={false}
            revision={revision}
            skeleton={skeleton}
        >
            {(data) =>
                data.screen === "moved" ? (
                    <MovedRegion to={data.to}>{skeleton}</MovedRegion>
                ) : data.screen === "ready" ? (
                    <ConnectChannelView bridgeReady />
                ) : (
                    <ConnectChannelView
                        bridgeReady={false}
                        bridgeHref={data.bridgeHref ?? undefined}
                    />
                )
            }
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
