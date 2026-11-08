"use client";

/**
 * The inbox screens' data, asked for after their shells paint. Each view draws
 * its own heading, so the page hands the same heading in for the skeleton and
 * it is on screen before the data is.
 */

import type { ReactNode } from "react";
import { InboxView } from "./inbox-view";
import { paintRead } from "../paint-read";
import { LogsView } from "./logs/logs-view";
import { MovedRegion } from "../moved-region";
import { AfterPaint } from "@/components/after-paint";
import { ContactsView } from "./contacts/contacts-view";
import { ChannelsView } from "./channels/channels-view";
import { CardSkeleton, TableSkeleton } from "../region-skeletons";
import { ConnectChannelView } from "./channels/connect/connect-view";

type Shell = { skeleton: ReactNode; revision: number };

export function InboxLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.inbox"
            load={() => paintRead("inbox")}
            persist={false}
            revision={revision}
            skeleton={skeleton}
        >
            {(data) => (
                <InboxView
                    initialChannels={data.channels}
                    initialConversations={data.conversations}
                    bridgeReady={data.ready}
                />
            )}
        </AfterPaint>
    );
}

export function ChannelsLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.inbox.channels"
            load={() => paintRead("inbox.channels")}
            revision={revision}
            skeleton={skeleton}
        >
            {(data) => <ChannelsView initialChannels={data.channels} />}
        </AfterPaint>
    );
}

export function ContactsLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.inbox.contacts"
            load={() => paintRead("inbox.contacts")}
            persist={false}
            revision={revision}
            skeleton={skeleton}
        >
            {(data) => <ContactsView initialContacts={data.contacts} />}
        </AfterPaint>
    );
}

export function LogsLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.inbox.logs"
            load={() => paintRead("inbox.logs")}
            persist={false}
            revision={revision}
            skeleton={skeleton}
        >
            {(data) => <LogsView initialActivity={data.activity} />}
        </AfterPaint>
    );
}

/** The channel picker, the way to the bridge, or - with no bridge - the email screen. */
export function ConnectChannelLoader({ skeleton, revision }: Shell) {
    return (
        <AfterPaint
            cacheKey="admin.inbox.connect"
            load={() => paintRead("inbox.connect")}
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
                    <ConnectChannelView bridgeReady={false} bridgeHref={data.bridgeHref ?? undefined} />
                )
            }
        </AfterPaint>
    );
}

export const tableSkeleton = <TableSkeleton rows={6} />;
export const cardsSkeleton = (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
        <CardSkeleton lines={1} />
    </div>
);
