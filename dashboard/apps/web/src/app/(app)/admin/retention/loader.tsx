"use client";

import { paintRead } from "../paint-read";
import { MailBodyForm } from "./mail-body-form";
import { RetentionView } from "./retention-view";
import { CardSkeleton } from "../region-skeletons";
import { AfterPaint } from "@/components/after-paint";

/** The policy form and the mail-body window; the counts load inside the view. */
export function RetentionLoader({ revision }: { revision: number }) {
    return (
        <AfterPaint
            cacheKey="admin.retention"
            load={() => paintRead("retention")}
            revision={revision}
            skeleton={
                <>
                    <CardSkeleton lines={3} />
                    <CardSkeleton lines={1} className="mt-4" />
                </>
            }
        >
            {(data) => (
                <>
                    <RetentionView policy={data.policy} />
                    <div className="mt-4">
                        <MailBodyForm kept={data.kept} />
                    </div>
                </>
            )}
        </AfterPaint>
    );
}
