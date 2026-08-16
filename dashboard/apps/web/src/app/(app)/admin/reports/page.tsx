/**
 * Reported messages (/admin/reports).
 *
 * The one place an instance answers for what is said inside it. Reporting is
 * open to anybody who can see a message; answering for it is the instance's, and
 * that is the only check here.
 */

import { PageHeader } from "@polaris/ui";
import { requireAdmin } from "@/lib/session";
import { ReportsView } from "./reports-view";
import { listReports } from "@/lib/chat/reports";
import { CHAT_REPORT_STATUSES } from "@polaris/core";
import type { ChatReportStatus } from "@polaris/core";

export const dynamic = "force-dynamic";

/** The filter as a value the service takes, from a string in an address bar. */
function statusFrom(raw: string | undefined): ChatReportStatus | "all" {
    if (raw === "all") return "all";
    return (CHAT_REPORT_STATUSES as readonly string[]).includes(raw ?? "")
        ? (raw as ChatReportStatus)
        : "open";
}

export default async function ReportsPage({
    searchParams
}: {
    searchParams: Promise<{ status?: string }>;
}) {
    await requireAdmin();
    const status = statusFrom((await searchParams).status);
    const reports = await listReports(status);

    return (
        <>
            <PageHeader
                title="Reported messages"
                description="What people in this instance have said is wrong with something. Removing a message here follows the same rules a moderator inside the conversation would."
            />
            <ReportsView reports={reports} status={status} />
        </>
    );
}
