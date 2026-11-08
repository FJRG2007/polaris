"use server";

import { z } from "zod";
import { requireAdmin } from "@/lib/session";
import { listReports } from "@/lib/chat/reports";
import { listSafetyCases } from "@/lib/safety-queue";
import type { ChatReportStatus, SafetyCaseStatus } from "@polaris/core";
import { CHAT_REPORT_STATUSES, SAFETY_CASE_STATUSES } from "@polaris/core";

const statusSchema = z.string().trim().max(40).optional();

/**
 * The URL's `status` as each list's own filter. The two lists name their states
 * differently, so "open" maps across and any case-only state shows the reports'
 * default.
 */
function statusFrom(raw: string | undefined): {
    cases: SafetyCaseStatus | "all";
    reports: ChatReportStatus | "all";
} {
    if (raw === "all") return { cases: "all", reports: "all" };
    if ((SAFETY_CASE_STATUSES as readonly string[]).includes(raw ?? "")) {
        return {
            cases: raw as SafetyCaseStatus,
            reports: raw === "open" ? "open" : (CHAT_REPORT_STATUSES[0] as ChatReportStatus)
        };
    }
    return { cases: "open", reports: "open" };
}

/** The safety cases and chat reports in the state the URL asks for. */
export async function loadSafetyAction(status?: string) {
    await requireAdmin();
    const wanted = statusFrom(statusSchema.parse(status));
    const [cases, reports] = await Promise.all([
        listSafetyCases(wanted.cases),
        listReports(wanted.reports)
    ]);
    return { cases, reports };
}
