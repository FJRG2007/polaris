"use client";

/**
 * The deployment's audit trail, and whether it can still be trusted.
 *
 * The rows arrive from /api/admin/activity after the screen has painted, so
 * opening Activity never waits on the audit query - the header, the filters and
 * the table chrome are there immediately and only the rows are sketched. The
 * integrity panel reads its own route for the same reason.
 */

import { PageHeader } from "@polaris/ui";
import { AuditIntegrity } from "./audit-integrity";
import { AuditFeed } from "@/components/audit-feed";
import { useTranslations } from "@/components/i18n/i18n-provider";

export function ActivityView() {
    const t = useTranslations("admin");
    return (
        <>
            <PageHeader
                title={t("activity.page.title")}
                description={t("activity.page.description")}
            />
            <div className="flex flex-col gap-4">
                <AuditIntegrity />
                <AuditFeed
                    endpoint="/api/admin/activity"
                    exportEndpoint="/api/admin/activity/export"
                    path="/admin/activity"
                    cacheKey="admin.activity"
                    contextLabel={t("activity.feed.who")}
                    emptyLabel={t("activity.feed.empty")}
                    context={(entry) => entry.actorName}
                    detail={(entry) =>
                        entry.targetType ? [entry.targetType, entry.targetId].filter(Boolean).join(" ") : ""
                    }
                />
            </div>
        </>
    );
}
