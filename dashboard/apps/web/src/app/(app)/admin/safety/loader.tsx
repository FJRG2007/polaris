"use client";

import { paintRead } from "../paint-read";
import { SafetyView } from "./safety-view";
import { TableSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

/** The cases and reports for one filter. Not kept in the tab: a safety queue. */
export function SafetyLoader({
    status,
    shownStatus,
    revision
}: {
    /** The filter as the address bar has it, checked again by the read. */
    status: string | undefined;
    /** The filter the view marks as chosen. */
    shownStatus: string;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey={`admin.safety:${status ?? ""}`}
            load={() => paintRead("safety", status ? { status } : {})}
            persist={false}
            revision={revision}
            skeleton={<TableSkeleton rows={6} />}
        >
            {(data) => <SafetyView cases={data.cases} reports={data.reports} status={shownStatus} />}
        </AfterPaint>
    );
}
