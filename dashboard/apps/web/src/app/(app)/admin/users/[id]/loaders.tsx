"use client";

/**
 * The regions of one person's record that wait for data. The shell around them
 * (the way back, the section tabs) is drawn by the server at once.
 *
 * The header, overview and access sections are kept in the tab, so reopening a
 * record paints it straight away; the security, sessions and danger sections
 * are account-access data and are always asked for fresh.
 */

import * as data from "./data";
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

export function UserRecordHeader({ userId, revision }: RegionProps) {
    const t = useTranslations("admin");
    return (
        <AfterPaint
            cacheKey={`admin-user:${userId}`}
            load={() => data.loadUserRecordAction(userId)}
            revision={revision}
            skeleton={<RecordHeaderSkeleton />}
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
    return (
        <AfterPaint
            cacheKey={`admin-user-overview:${userId}`}
            load={() => data.loadUserOverviewAction(userId)}
            revision={revision}
            skeleton={<CardSkeleton lines={4} />}
        >
            {(overview) => (
                <OverviewControls user={overview.account} roles={overview.roles} isSelf={overview.isSelf} />
            )}
        </AfterPaint>
    );
}

export function UserAccessRegion({ userId, revision }: RegionProps) {
    return (
        <AfterPaint
            cacheKey={`admin-user-access:${userId}`}
            load={() => data.loadUserAccessAction(userId)}
            revision={revision}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={1} />
                    <CardSkeleton lines={4} />
                    <CardSkeleton lines={4} />
                </div>
            }
        >
            {(access) => <UserAccessView {...access} />}
        </AfterPaint>
    );
}

export function UserSecurityRegion({ userId, revision }: RegionProps) {
    return (
        <AfterPaint
            cacheKey={`admin-user-security:${userId}`}
            load={() => data.loadUserSecurityAction(userId)}
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
    return (
        <AfterPaint
            cacheKey={`admin-user-sessions:${userId}`}
            load={() => data.loadUserRecordAction(userId)}
            persist={false}
            revision={revision}
            skeleton={<CardSkeleton lines={4} />}
        >
            {(account) => <SessionsSection user={account} />}
        </AfterPaint>
    );
}

export function UserDangerRegion({ userId, revision }: RegionProps) {
    return (
        <AfterPaint
            cacheKey={`admin-user-danger:${userId}`}
            load={() => data.loadUserDangerAction(userId)}
            persist={false}
            revision={revision}
            skeleton={<CardSkeleton lines={2} />}
        >
            {(danger) => <DangerSection user={danger.account} isSelf={danger.isSelf} />}
        </AfterPaint>
    );
}
