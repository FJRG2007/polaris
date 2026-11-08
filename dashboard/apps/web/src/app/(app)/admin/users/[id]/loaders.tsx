"use client";

/**
 * The regions of one person's record that wait for data. The shell around them
 * (the way back, the section tabs) is drawn by the server at once.
 *
 * The header, overview and access sections are kept in the tab, so reopening a
 * record paints it straight away; the security, sessions and danger sections
 * are account-access data and are always asked for fresh.
 *
 * The header asks nothing of its own: server actions leave the browser one at
 * a time, so a read for the name alone held every section behind it. Each
 * section hands the header what its own answer carried (`UserRecordFrame`).
 */

import { createContext, useContext, useState, type ReactNode } from "react";
import type * as data from "./data";
import { paintRead } from "@/app/(app)/admin/paint-read";
import { UserAccessView } from "./access-view";
import { Badge, PageHeader } from "@polaris/ui";
import { DangerSection } from "./danger-section";
import { LimitsSection } from "./limits-section";
import { SessionsSection } from "./sessions-section";
import { AfterPaint } from "@/components/after-paint";
import { OverviewControls } from "./overview-controls";
import { CredentialsSection } from "./credentials-section";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { CardSkeleton, RecordHeaderSkeleton } from "@/app/(app)/admin/region-skeletons";

interface RegionProps {
    userId: string;
    revision: number;
}

/**
 * The next heading a section reads, for the header waiting on it. A section
 * whose read fails leaves the header waiting: the section shows the failure and
 * its retry, and the answer that retry brings is the one the header draws.
 */
interface HeadingFeed {
    next: () => Promise<data.UserRecordHeading | null>;
    publish: (heading: data.UserRecordHeading | null) => void;
}

function createHeadingFeed(): HeadingFeed {
    let waiting: Array<(heading: data.UserRecordHeading | null) => void> = [];
    return {
        next: () => new Promise((resolve) => waiting.push(resolve)),
        publish: (heading) => {
            const current = waiting;
            waiting = [];
            for (const resolve of current) resolve(heading);
        }
    };
}

const HeadingFeedContext = createContext<HeadingFeed | null>(null);

/** Around the header and the section under it, so the one can draw what the other read. */
export function UserRecordFrame({ children }: { children: ReactNode }) {
    const [feed] = useState(createHeadingFeed);
    return <HeadingFeedContext.Provider value={feed}>{children}</HeadingFeedContext.Provider>;
}

/** What a section passes its `AfterPaint` as `onAnswer` so the header follows it. */
function usePublishHeading(): (answer: { header: data.UserRecordHeading } | null) => void {
    const feed = useContext(HeadingFeedContext);
    return (answer) => feed?.publish(answer?.header ?? null);
}

export function UserRecordHeader({ userId, revision }: RegionProps) {
    const t = useTranslations("admin");
    const feed = useContext(HeadingFeedContext);
    return (
        <AfterPaint
            cacheKey={`admin-user:${userId}`}
            load={() => feed?.next() ?? Promise.resolve(null)}
            revision={revision}
            skeleton={<RecordHeaderSkeleton />}
            missing={null}
        >
            {(account) => (
                <PageHeader
                    title={account.name}
                    description={account.email}
                    actions={
                        <>
                            {account.isAdmin ? (
                                <Badge variant="primary">{t("usersDetail.badges.admin")}</Badge>
                            ) : null}
                            {account.banned ? (
                                <Badge variant="danger">{t("usersDetail.badges.banned")}</Badge>
                            ) : null}
                        </>
                    }
                />
            )}
        </AfterPaint>
    );
}

export function UserOverviewRegion({ userId, revision }: RegionProps) {
    const publishHeading = usePublishHeading();
    return (
        <AfterPaint
            onAnswer={publishHeading}
            cacheKey={`admin-user-overview:${userId}`}
            load={() => paintRead("users.overview", { id: userId })}
            revision={revision}
            skeleton={<CardSkeleton lines={4} />}
        >
            {(overview) => (
                <OverviewControls
                    user={overview.account}
                    roles={overview.roles}
                    isSelf={overview.isSelf}
                />
            )}
        </AfterPaint>
    );
}

export function UserAccessRegion({ userId, revision }: RegionProps) {
    const publishHeading = usePublishHeading();
    return (
        <AfterPaint
            onAnswer={publishHeading}
            cacheKey={`admin-user-access:${userId}`}
            load={() => paintRead("users.access", { id: userId })}
            revision={revision}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={1} />
                    <CardSkeleton lines={4} />
                    <CardSkeleton lines={4} />
                </div>
            }
        >
            {(access) => (
                <UserAccessView
                    userId={access.userId}
                    role={access.role}
                    roles={access.roles}
                    groups={access.groups}
                    memberOf={access.memberOf}
                    policies={access.policies}
                    attachedPolicies={access.attachedPolicies}
                />
            )}
        </AfterPaint>
    );
}

export function UserSecurityRegion({ userId, revision }: RegionProps) {
    const publishHeading = usePublishHeading();
    return (
        <AfterPaint
            onAnswer={publishHeading}
            cacheKey={`admin-user-security:${userId}`}
            load={() => paintRead("users.security", { id: userId })}
            persist={false}
            revision={revision}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={3} />
                    <CardSkeleton lines={3} />
                </div>
            }
        >
            {(security) => (
                <div className="flex flex-col gap-4">
                    <CredentialsSection user={security.account} isSelf={security.isSelf} />
                    <LimitsSection user={security.account} groups={security.groups} />
                </div>
            )}
        </AfterPaint>
    );
}

export function UserSessionsRegion({ userId, revision }: RegionProps) {
    const publishHeading = usePublishHeading();
    return (
        <AfterPaint
            onAnswer={publishHeading}
            cacheKey={`admin-user-sessions:${userId}`}
            load={() => paintRead("users.sessions", { id: userId })}
            persist={false}
            revision={revision}
            skeleton={<CardSkeleton lines={4} />}
        >
            {(sessions) => <SessionsSection user={sessions.account} />}
        </AfterPaint>
    );
}

export function UserDangerRegion({ userId, revision }: RegionProps) {
    const publishHeading = usePublishHeading();
    return (
        <AfterPaint
            onAnswer={publishHeading}
            cacheKey={`admin-user-danger:${userId}`}
            load={() => paintRead("users.danger", { id: userId })}
            persist={false}
            revision={revision}
            skeleton={<CardSkeleton lines={2} />}
        >
            {(danger) => <DangerSection user={danger.account} isSelf={danger.isSelf} />}
        </AfterPaint>
    );
}
