"use client";

import type { ComponentProps } from "react";
import { paintRead } from "../paint-read";
import { CardSkeleton } from "../region-skeletons";
import { DiagnosticsView } from "./diagnostics-view";
import { AfterPaint } from "@/components/after-paint";

export function DiagnosticsLoader({
    checks
}: {
    checks: ComponentProps<typeof DiagnosticsView>["checks"];
}) {
    return (
        <AfterPaint
            cacheKey="admin.diagnostics"
            load={() => paintRead("diagnostics")}
            skeleton={
                <div className="flex flex-col gap-4">
                    <CardSkeleton lines={2} />
                    <CardSkeleton lines={5} />
                </div>
            }
        >
            {(data) => <DiagnosticsView checks={checks} initialSpeed={data.speed} />}
        </AfterPaint>
    );
}
