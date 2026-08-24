/**
 * What needs an administrator (/admin/safety).
 *
 * One screen for one question. Reported messages were already here under their
 * own address; reported people and accounts that have shut themselves down had
 * nowhere to be. Three queues would have been three places to remember to look,
 * and a thing nobody looks at is not a queue.
 *
 * The two halves stay two services underneath, because they are two shapes: a
 * report about a message carries the message, and a case about a person carries
 * a person. What they share is the answer - somebody decides, and the decision is
 * recorded with their name on it.
 */

import { PageHeader } from "@polaris/ui";
import { SafetyView } from "./safety-view";
import { requireAdmin } from "@/lib/session";
import { listReports } from "@/lib/chat/reports";
import { listSafetyCases } from "@/lib/safety-queue";
import type { ChatReportStatus, SafetyCaseStatus } from "@polaris/core";
import { CHAT_REPORT_STATUSES, SAFETY_CASE_STATUSES } from "@polaris/core";

export const dynamic = "force-dynamic";

/** The filter as each service takes it, from one string in an address bar.
 *  "open" is the default because the queue is for what has not been answered. */
function statusFrom(raw: string | undefined): {
    cases: SafetyCaseStatus | "all";
    reports: ChatReportStatus | "all";
} {
    if (raw === "all") return { cases: "all", reports: "all" };
    if ((SAFETY_CASE_STATUSES as readonly string[]).includes(raw ?? "")) {
        // The two vocabularies only overlap on "open"; anything else means this
        // filter is about cases, so the message queue is asked for everything and
        // filtered to nothing by the view.
        return {
            cases: raw as SafetyCaseStatus,
            reports: raw === "open" ? "open" : (CHAT_REPORT_STATUSES[0] as ChatReportStatus)
        };
    }
    return { cases: "open", reports: "open" };
}

export default async function SafetyPage({
    searchParams
}: {
    searchParams: Promise<{ status?: string }>;
}) {
    await requireAdmin();
    const status = (await searchParams).status;
    const wanted = statusFrom(status);
    const [cases, reports] = await Promise.all([
        listSafetyCases(wanted.cases),
        listReports(wanted.reports)
    ]);

    return (
        <>
            <PageHeader
                title="Safety"
                description="Everything this instance has been asked to look at: accounts that have locked themselves down, people who have been reported, and messages somebody objected to."
            />
            <SafetyView
                cases={cases}
                reports={reports}
                status={(SAFETY_CASE_STATUSES as readonly string[]).includes(status ?? "") || status === "all" ? (status as string) : "open"}
            />
        </>
    );
}
